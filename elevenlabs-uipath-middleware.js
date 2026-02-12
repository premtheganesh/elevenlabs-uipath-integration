// ElevenLabs + UiPath Middleware
// Handles async UiPath responses and returns clean JSON to ElevenLabs

const fetch = require('node-fetch');

// ============================================
// CONFIGURATION - REPLACE WITH YOUR VALUES
// ============================================

const CONFIG = {
  // UiPath Orchestrator credentials
  ORCHESTRATOR_URL: 'https://cloud.uipath.com/leanjar',
  ORCHESTRATOR_TENANT: 'default',
  ORCHESTRATOR_FOLDER_ID: '1072886',
  
  // OAuth credentials from External Application you just created
  CLIENT_ID: 'YOUR_CLIENT_ID_HERE',           // Replace with your Client ID
  CLIENT_SECRET: 'YOUR_CLIENT_SECRET_HERE',   // Replace with your Client Secret
  
  // UiPath Webhook URLs (your existing webhooks)
  WEBHOOK_CHECK_AVAILABILITY: 'https://cloud.uipath.com/leaniar/223c44b8-73b7-4e80-881e-a022b0541ebe/elements_/v1/webhooks/events/GvZItMrGlGk5-kXOsNaOHqIifwmDEAGZcAO5rsrYHE3yJzRr67P9LjYdqxUg9qnuIJMgqLoGyQwsyAg13lr9qA',
  WEBHOOK_BOOK_APPOINTMENT: 'https://cloud.uipath.com/leaniar/223c44b8-73b7-4e80-881e-a022b0541ebe/elements_/v1/webhooks/events/GvZItMrGlGk5-kXOsNaOHqIifwmDEAGZcAO5rsrYHE3yJzRr67P9LjYdqxUg9qnuIJMgqLoGyQwsyAg13lr9qA',
  
  // Timing settings
  WAIT_TIME_MS: 5000,  // Wait 5 seconds for UiPath to process
  MAX_RETRIES: 3       // Retry up to 3 times if job not found
};

// ============================================
// OAUTH TOKEN MANAGEMENT
// ============================================

let cachedToken = null;
let tokenExpiry = null;

async function getOAuthToken() {
  // Return cached token if still valid
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  console.log('Fetching new OAuth token...');
  
  const tokenUrl = `${CONFIG.ORCHESTRATOR_URL}/identity_/connect/token`;
  
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CONFIG.CLIENT_ID,
    client_secret: CONFIG.CLIENT_SECRET,
    scope: 'OR.Jobs OR.Jobs.Read'
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  if (!response.ok) {
    throw new Error(`OAuth token request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000; // Refresh 1 min before expiry
  
  console.log('OAuth token obtained successfully');
  return cachedToken;
}

// ============================================
// FETCH JOB OUTPUT FROM ORCHESTRATOR
// ============================================

async function getLatestJobOutput(processName, retryCount = 0) {
  const token = await getOAuthToken();
  
  // Get recent jobs for this process
  const jobsUrl = `${CONFIG.ORCHESTRATOR_URL}/${CONFIG.ORCHESTRATOR_TENANT}/orchestrator_/odata/Jobs`;
  const filter = `?$filter=ProcessName eq '${processName}' and State eq 'Successful'&$orderby=EndTime desc&$top=1`;
  
  const response = await fetch(jobsUrl + filter, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-UIPATH-TenantName': CONFIG.ORCHESTRATOR_TENANT,
      'X-UIPATH-OrganizationUnitId': CONFIG.ORCHESTRATOR_FOLDER_ID
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch jobs: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  
  if (!data.value || data.value.length === 0) {
    // No completed job yet, retry if we haven't exceeded max retries
    if (retryCount < CONFIG.MAX_RETRIES) {
      console.log(`No completed job found, retrying (${retryCount + 1}/${CONFIG.MAX_RETRIES})...`);
      await sleep(2000); // Wait 2 more seconds
      return getLatestJobOutput(processName, retryCount + 1);
    }
    throw new Error('No completed job found after max retries');
  }

  const job = data.value[0];
  const outputArguments = job.OutputArguments;
  
  if (!outputArguments) {
    throw new Error('Job has no output arguments');
  }

  // Parse the output (it's a JSON string)
  return JSON.parse(outputArguments);
}

// ============================================
// HELPER: SLEEP FUNCTION
// ============================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// ENDPOINT 1: CHECK AVAILABILITY
// ============================================

async function handleCheckAvailability(req, res) {
  console.log('=== CHECK AVAILABILITY REQUEST ===');
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  try {
    const { date, time, duration } = req.body;

    // Validate input
    if (!date || !time || !duration) {
      return res.status(400).json({
        error: 'Missing required parameters: date, time, duration'
      });
    }

    // Step 1: Trigger UiPath webhook
    console.log('Calling UiPath webhook...');
    const webhookResponse = await fetch(CONFIG.WEBHOOK_CHECK_AVAILABILITY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, time, duration })
    });

    if (!webhookResponse.ok) {
      throw new Error(`UiPath webhook failed: ${webhookResponse.status}`);
    }

    const webhookData = await webhookResponse.json();
    console.log('Webhook response:', webhookData);

    // Step 2: Wait for UiPath to process
    console.log(`Waiting ${CONFIG.WAIT_TIME_MS}ms for UiPath to process...`);
    await sleep(CONFIG.WAIT_TIME_MS);

    // Step 3: Fetch actual result from Orchestrator
    console.log('Fetching job output from Orchestrator...');
    const output = await getLatestJobOutput('check_availability');

    // Step 4: Return clean response to ElevenLabs
    const response = {
      available: output.available,
      message: output.message,
      date: output.date,
      time: output.time,
      duration: output.duration
    };

    console.log('Returning response:', response);
    res.json(response);

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      available: false,
      message: 'Sorry, I was unable to check availability. Please try again.'
    });
  }
}

// ============================================
// ENDPOINT 2: BOOK APPOINTMENT
// ============================================

async function handleBookAppointment(req, res) {
  console.log('=== BOOK APPOINTMENT REQUEST ===');
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  try {
    const { customer_name, phone, email, date, time, reason } = req.body;

    // Validate input
    if (!customer_name || !phone || !email || !date || !time) {
      return res.status(400).json({
        error: 'Missing required parameters: customer_name, phone, email, date, time'
      });
    }

    // Step 1: Trigger UiPath webhook
    console.log('Calling UiPath webhook...');
    const webhookResponse = await fetch(CONFIG.WEBHOOK_BOOK_APPOINTMENT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_name, phone, email, date, time, reason })
    });

    if (!webhookResponse.ok) {
      throw new Error(`UiPath webhook failed: ${webhookResponse.status}`);
    }

    const webhookData = await webhookResponse.json();
    console.log('Webhook response:', webhookData);

    // Step 2: Wait for UiPath to process
    console.log(`Waiting ${CONFIG.WAIT_TIME_MS}ms for UiPath to process...`);
    await sleep(CONFIG.WAIT_TIME_MS);

    // Step 3: Fetch actual result from Orchestrator
    console.log('Fetching job output from Orchestrator...');
    const output = await getLatestJobOutput('book_appointment');

    // Step 4: Return clean response to ElevenLabs
    const response = {
      success: output.success,
      message: output.message,
      confirmation_number: output.confirmation_number
    };

    console.log('Returning response:', response);
    res.json(response);

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      success: false,
      message: 'Sorry, I was unable to complete the booking. Please try again.'
    });
  }
}

// ============================================
// EXPORT HANDLERS (for Vercel/Netlify)
// ============================================

module.exports = {
  checkAvailability: handleCheckAvailability,
  bookAppointment: handleBookAppointment
};

// ============================================
// EXPRESS SERVER (for local testing)
// ============================================

if (require.main === module) {
  const express = require('express');
  const app = express();
  
  app.use(express.json());
  
  app.post('/check-availability', handleCheckAvailability);
  app.post('/book-appointment', handleBookAppointment);
  
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Middleware running on port ${PORT}`);
    console.log(`- Check availability: http://localhost:${PORT}/check-availability`);
    console.log(`- Book appointment: http://localhost:${PORT}/book-appointment`);
  });
}
