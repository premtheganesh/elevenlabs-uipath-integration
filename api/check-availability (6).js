// Check Availability Endpoint
const fetch = require('node-fetch');

// Configuration
const CONFIG = {
  ORCHESTRATOR_URL: 'https://cloud.uipath.com/leaniar',
  ORCHESTRATOR_TENANT: 'default',
  ORCHESTRATOR_FOLDER_ID: '1072886',
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,
  WEBHOOK_URL: 'https://cloud.uipath.com/leaniar/223c44b8-73b7-4e80-881e-a022b0541ebe/elements_/v1/webhooks/events/GvZItMrGlGk5-kXOsNaOHqIifwmDEAGZcAO5rsrYHE3yJzRr67P9LjYdqxUg9qnuIJMgqLoGyQwsyAg13lr9qA',
  WAIT_TIME_MS: 6000,
  MAX_RETRIES: 3
};

let cachedToken = null;
let tokenExpiry = null;

async function getOAuthToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const tokenUrl = `${CONFIG.ORCHESTRATOR_URL}/identity_/connect/token`;
  
  console.log('OAuth Token Request:');
  console.log('URL:', tokenUrl);
  console.log('CLIENT_ID:', CONFIG.CLIENT_ID ? `${CONFIG.CLIENT_ID.substring(0, 10)}...` : 'MISSING');
  console.log('CLIENT_SECRET:', CONFIG.CLIENT_SECRET ? 'SET' : 'MISSING');
  
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CONFIG.CLIENT_ID,
    client_secret: CONFIG.CLIENT_SECRET,
    scope: 'OR.Jobs OR.Jobs.Read'
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('OAuth Error Response:', errorText);
    throw new Error(`OAuth failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
  
  console.log('OAuth token obtained successfully');
  return cachedToken;
}

async function getJobOutputByCorrelationId(correlationId, retryCount = 0) {
  const token = await getOAuthToken();
  
  const jobsUrl = `${CONFIG.ORCHESTRATOR_URL}/${CONFIG.ORCHESTRATOR_TENANT}/orchestrator_/odata/Jobs`;
  const filter = `?$filter=Key eq guid'${correlationId}'`;
  
  console.log('Fetching job by correlationId:');
  console.log('URL:', jobsUrl + filter);
  console.log('CorrelationId:', correlationId);
  console.log('Tenant:', CONFIG.ORCHESTRATOR_TENANT);
  console.log('Folder ID:', CONFIG.ORCHESTRATOR_FOLDER_ID);
  
  const response = await fetch(jobsUrl + filter, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-UIPATH-TenantName': CONFIG.ORCHESTRATOR_TENANT,
      'X-UIPATH-OrganizationUnitId': CONFIG.ORCHESTRATOR_FOLDER_ID
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Jobs API Error Response:', errorText);
    throw new Error(`Failed to fetch jobs: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  if (!data.value || data.value.length === 0) {
    if (retryCount < CONFIG.MAX_RETRIES) {
      console.log(`Job not found yet, retrying (${retryCount + 1}/${CONFIG.MAX_RETRIES})...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return getJobOutputByCorrelationId(correlationId, retryCount + 1);
    }
    throw new Error('Job not found after max retries');
  }

  const job = data.value[0];
  
  // Check if job is still running
  if (job.State !== 'Successful') {
    if (retryCount < CONFIG.MAX_RETRIES) {
      console.log(`Job still running (State: ${job.State}), retrying (${retryCount + 1}/${CONFIG.MAX_RETRIES})...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return getJobOutputByCorrelationId(correlationId, retryCount + 1);
    }
    throw new Error(`Job did not complete successfully. Final state: ${job.State}`);
  }
  
  console.log('Found job:', job.Key);
  console.log('Raw OutputArguments:', job.OutputArguments);
  
  if (!job.OutputArguments) {
    throw new Error('Job has no OutputArguments');
  }
  
  const parsed = JSON.parse(job.OutputArguments);
  console.log('Parsed output:', JSON.stringify(parsed, null, 2));
  
  return parsed;
}

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('=== CHECK AVAILABILITY REQUEST ===');
  console.log('Body:', JSON.stringify(req.body, null, 2));

  try {
    const { date, time, duration } = req.body;

    if (!date || !time || !duration) {
      return res.status(400).json({
        error: 'Missing required parameters',
        available: false,
        message: 'Invalid request'
      });
    }

    // Call UiPath webhook
    console.log('Calling UiPath webhook...');
    const webhookResponse = await fetch(CONFIG.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, time, duration })
    });

    if (!webhookResponse.ok) {
      throw new Error(`Webhook failed: ${webhookResponse.status}`);
    }

    const webhookData = await webhookResponse.json();
    const correlationId = webhookData.correlationId;
    
    console.log('Webhook triggered, correlationId:', correlationId);
    console.log(`Waiting ${CONFIG.WAIT_TIME_MS}ms...`);
    await new Promise(resolve => setTimeout(resolve, CONFIG.WAIT_TIME_MS));

    // Fetch result using correlationId
    console.log('Fetching job output...');
    const output = await getJobOutputByCorrelationId(correlationId);

    const response = {
      available: output.available,
      message: output.message,
      date: output.date,
      time: output.time,
      duration: output.duration
    };

    console.log('Success:', response);
    return res.status(200).json(response);

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: error.message,
      available: false,
      message: 'Unable to check availability. Please try again.'
    });
  }
};
