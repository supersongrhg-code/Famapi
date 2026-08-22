const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;

module.exports = async (req, res) => {
  // CORS Headers enable kar rahe hain taaki kisi bhi website/domain se call ho sake
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET ya POST dono se data accept karega
  const email = (req.query.email || req.body?.email || req.query.user || req.body?.user || '').trim();
  const pass = (req.query.pass || req.body?.pass || req.query.password || req.body?.password || '').replace(/\s+/g, '');
  const utr = (req.query.utr || req.body?.utr || '').trim();

  // Basic Validation
  if (!email || !pass || !utr) {
    return res.status(400).json({
      status: 'error',
      message: 'email, pass (App Password bina space ke), aur utr daalna zaroori hai.'
    });
  }

  if (utr.length < 8) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid UTR format. UTR minimum 8 digits ka hona chahiye.'
    });
  }

  // IMAP Configuration
  const config = {
    imap: {
      user: email,
      password: pass,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      authTimeout: 10000,
      connTimeout: 10000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  let connection;

  try {
    // 1. Connect to Gmail
    connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    // 2. Search query optimize (UTR check)
    const searchCriteria = [['TEXT', utr]];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT', ''],
      markSeen: false
    };

    const messages = await connection.search(searchCriteria, fetchOptions);

    if (!messages || messages.length === 0) {
      connection.end();
      return res.status(404).json({
        status: 'error',
        utr: utr,
        message: 'UTR inbox mein nahi mila. Payment check karein.'
      });
    }

    // Sabse latest matching email fetch karna
    const latestMessage = messages[messages.length - 1];
    const fullBodyPart = latestMessage.parts.find(part => part.which === '') || latestMessage.parts[0];
    const parsed = await simpleParser(fullBodyPart.body);

    const emailSubject = parsed.subject || '';
    const emailBody = (parsed.text || '') + ' ' + (parsed.html ? parsed.html.replace(/<[^>]*>?/gm, ' ') : '');
    const emailDate = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
    const sender = parsed.from ? parsed.from.text : 'Unknown';

    // 3. Multi-Regex Amount Extraction (FamPay / Paytm / PhonePe / GPay / Bank SMS formats)
    let amount = "0";
    const cleanContent = (emailSubject + " " + emailBody).replace(/[\r\n\t]+/g, ' ');

    const amountPatterns = [
      /(?:Rs\.?|INR|₹|Amount|Credited\s+by|Received)\s*[:\-]?\s*([0-9,]+(?:\.[0-9]{1,2})?)/i,
      /(?:deposited|transferred|added|paid)\s*[:\-]?\s*(?:Rs\.?|INR|₹)?\s*([0-9,]+(?:\.[0-9]{1,2})?)/i,
      /([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:INR|Rs|rupees)/i
    ];

    for (const pattern of amountPatterns) {
      const match = cleanContent.match(pattern);
      if (match && match[1]) {
        const potentialAmt = match[1].replace(/,/g, '');
        // Amount UTR number khud na ban jaye isliye sanity check
        if (potentialAmt !== utr && parseFloat(potentialAmt) > 0) {
          amount = potentialAmt;
          break;
        }
      }
    }

    connection.end();

    // 4. Clean API Output
    return res.status(200).json({
      status: 'success',
      code: 200,
      data: {
        utr: utr,
        amount: amount,
        sender: sender,
        date: emailDate,
        subject: emailSubject
      },
      message: 'Payment Auto Verified Successfully ✅'
    });

  } catch (err) {
    if (connection) {
      try { connection.end(); } catch (e) {}
    }

    return res.status(500).json({
      status: 'error',
      code: 500,
      message: err.message.includes('Invalid credentials')
        ? 'Gmail App Password galat hai ya 2FA off hai.'
        : 'Internal Server Error: ' + err.message
    });
  }
};
