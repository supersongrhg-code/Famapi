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

    // Get latest matching email
    const latestMessage = messages[messages.length - 1];
    const fullBodyPart = latestMessage.parts.find(part => part.which === '') || latestMessage.parts[0];
    const parsed = await simpleParser(fullBodyPart.body);

    const emailSubject = parsed.subject || '';
    const rawBody = (parsed.text || '') + ' ' + (parsed.html ? parsed.html.replace(/<[^>]*>?/gm, ' ') : '');
    const emailDate = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
    const sender = parsed.from ? parsed.from.text : 'Unknown';

    // Clean content — collapse all whitespace into single spaces
    const cleanContent = (emailSubject + ' ' + rawBody)
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    /* ============================================================
       🔥 EXACT AMOUNT EXTRACTION
       FamApp email format:
         "You have successfully received ₹25.0 from Manas Dalabehera"
       We need to capture: 25.0 (with decimal preserved!)
       ============================================================ */

    let amount = 0;
    let receiver = "";
    let matched = false;

    // PRIMARY PATTERN — exact FamApp phrase
    // Captures: ₹25.0, ₹44.89, Rs.100, INR 500.50 etc.
    // KEY FIX: Decimal part is [0-9]+ (1 or more) instead of {1,2}
    const primaryPattern = /You\s+have\s+successfully\s+received\s+(?:Rs\.?|INR|₹)?\s*([0-9]+(?:[,.][0-9]+)*)/i;
    const primaryMatch = cleanContent.match(primaryPattern);

    if (primaryMatch && primaryMatch[1]) {
      // Remove commas (Indian number format like 1,00,000)
      const rawAmount = primaryMatch[1].replace(/,/g, '');
      const parsedAmount = parseFloat(rawAmount);
      if (!isNaN(parsedAmount) && parsedAmount > 0) {
        amount = parsedAmount;
        matched = true;
      }
    }

    // Extract sender name ("from <Name>")
    if (matched) {
      const senderPattern = /You\s+have\s+successfully\s+received\s+(?:Rs\.?|INR|₹)?\s*[0-9]+(?:[,.][0-9]+)*\s+from\s+([A-Za-z][A-Za-z\s\.]{1,80})/i;
      const senderMatch = cleanContent.match(senderPattern);
      if (senderMatch && senderMatch[1]) {
        receiver = senderMatch[1].trim();
      }
    }

    // SECONDARY FALLBACK — Subject line pattern
    // "You received ₹25.0 in your FamX account"
    if (!matched) {
      const subjectPattern = /You\s+received\s+(?:Rs\.?|INR|₹)\s*([0-9]+(?:[,.][0-9]+)*)/i;
      const subjectMatch = cleanContent.match(subjectPattern);
      if (subjectMatch && subjectMatch[1]) {
        const rawAmount = subjectMatch[1].replace(/,/g, '');
        const parsedAmount = parseFloat(rawAmount);
        if (!isNaN(parsedAmount) && parsedAmount > 0) {
          amount = parsedAmount;
          matched = true;
        }
      }
    }

    // TERTIARY FALLBACK — Loose patterns
    if (!matched) {
      const loosePatterns = [
        /successfully\s+received\s+(?:Rs\.?|INR|₹)?\s*([0-9]+(?:[,.][0-9]+)*)/i,
        /received\s+(?:Rs\.?|INR|₹)\s*([0-9]+(?:[,.][0-9]+)*)/i,
        /(?:Rs\.?|INR|₹)\s*([0-9]+(?:[,.][0-9]+)*)\s+(?:credited|received|deposited)/i,
        /credited\s+(?:Rs\.?|INR|₹)?\s*([0-9]+(?:[,.][0-9]+)*)/i,
      ];
      for (const pattern of loosePatterns) {
        const m = cleanContent.match(pattern);
        if (m && m[1]) {
          const rawAmt = m[1].replace(/,/g, '');
          const parsedAmt = parseFloat(rawAmt);
          // Skip if it matches UTR number
          if (!isNaN(parsedAmt) && parsedAmt > 0 && rawAmt !== utr) {
            amount = parsedAmt;
            matched = true;
            break;
          }
        }
      }
    }

    connection.end();

    /* ============================================================
       FINAL RESPONSE
       ============================================================ */
    if (!matched || amount <= 0) {
      return res.status(404).json({
        status: 'error',
        utr: utr,
        message: 'Deposit not received — Amount could not be verified from email.'
      });
    }

    // Round to 2 decimals (safe)
    const finalAmount = Math.round(amount * 100) / 100;

    // SUCCESS
    return res.status(200).json({
      status: 'success',
      code: 200,
      amount: finalAmount,                    // ✅ Correct: 25.0 (not 250!)
      data: {
        utr: utr,
        amount: finalAmount,
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
