const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Accept data from GET or POST
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

    // 2. Search for UTR in mailbox
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
        message: 'Deposit not received — UTR not found in bank records.'
      });
    }

    // Sabse latest matching email fetch karo
    const latestMessage = messages[messages.length - 1];
    const fullBodyPart = latestMessage.parts.find(part => part.which === '') || latestMessage.parts[0];
    const parsed = await simpleParser(fullBodyPart.body);

    const emailSubject = parsed.subject || '';
    const rawBody = (parsed.text || '') + ' ' + (parsed.html ? parsed.html.replace(/<[^>]*>?/gm, ' ') : '');
    const emailDate = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
    const sender = parsed.from ? parsed.from.text : 'Unknown';

    // Clean content — collapse whitespace
    const cleanContent = (emailSubject + ' ' + rawBody)
      .replace(/\s+/g, ' ')
      .replace(/[\r\n\t]+/g, ' ')
      .trim();

    /* ============================================================
       🔥 EXACT FamApp Email Format Extraction
       Format: "You have successfully received ₹44.89 from Aryan raj"
       ============================================================ */

    let amount = "0";
    let receiver = "";
    let matched = false;

    // PRIMARY PATTERN — exact FamApp phrase
    // Matches: "You have successfully received ₹44.89 from Aryan raj"
    const primaryPattern = /You\s+have\s+successfully\s+received\s+([₹Rs\.]*\s*[\d,]+(?:\.\d{1,2})?)/i;
    const primaryMatch = cleanContent.match(primaryPattern);

    if (primaryMatch && primaryMatch[1]) {
      const rawAmount = primaryMatch[1].replace(/[₹Rs\.\s]/gi, '').replace(/,/g, '');
      const parsedAmount = parseFloat(rawAmount);
      if (!isNaN(parsedAmount) && parsedAmount > 0) {
        amount = parsedAmount.toFixed(2);
        matched = true;
      }
    }

    // Extract "from <Sender Name>" if present
    if (matched) {
      const senderPattern = /You\s+have\s+successfully\s+received\s+[₹Rs\.]*\s*[\d,]+(?:\.\d{1,2})?\s+from\s+([A-Za-z][A-Za-z\s\.]{1,60})/i;
      const senderMatch = cleanContent.match(senderPattern);
      if (senderMatch && senderMatch[1]) {
        receiver = senderMatch[1].trim();
      }
    }

    // SECONDARY FALLBACK — if primary didn't match, try looser patterns
    if (!matched) {
      const fallbackPatterns = [
        /successfully\s+received\s+([₹Rs\.]*\s*[\d,]+(?:\.\d{1,2})?)/i,
        /received\s+([₹Rs\.]*\s*[\d,]+(?:\.\d{1,2})?)\s+from/i,
        /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)\s+(?:credited|received|deposited)/i,
      ];
      for (const pattern of fallbackPatterns) {
        const m = cleanContent.match(pattern);
        if (m && m[1]) {
          const rawAmt = m[1].replace(/[₹Rs\.\s]/gi, '').replace(/,/g, '');
          const parsedAmt = parseFloat(rawAmt);
          // Sanity: amount should not equal UTR, and be positive
          if (!isNaN(parsedAmt) && parsedAmt > 0 && rawAmt !== utr) {
            amount = parsedAmt.toFixed(2);
            matched = true;
            break;
          }
        }
      }
    }

    connection.end();

    /* ============================================================
       FINAL RESPONSE — Clean & Simple
       ============================================================ */
    if (!matched || parseFloat(amount) <= 0) {
      return res.status(404).json({
        status: 'error',
        utr: utr,
        message: 'Deposit not received — Amount could not be verified from email.'
      });
    }

    // SUCCESS
    return res.status(200).json({
      status: 'success',
      code: 200,
      amount: parseFloat(amount),        // 👈 Direct amount at top level
      data: {
        utr: utr,
        amount: parseFloat(amount),
        sender: receiver || sender,
        date: emailDate,
        subject: emailSubject,
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
