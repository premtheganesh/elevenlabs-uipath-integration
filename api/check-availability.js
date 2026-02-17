// Check Availability - Best Practice Polling with Exponential Backoff
const fetch = require('node-fetch');

// --- CONFIGURATION ---
const CONFIG = {
  ORCHESTRATOR_URL: 'https://cloud.uipath.com/leaniar',
  ORCHESTRATOR_TENANT: 'default',
  ORGANIZATION_UNIT_ID: '1075762',  // Confirmed working from release info
  RELEASE_KEY: '17da421f-3373-4ae7-bd9f-95fc6417d104',
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,
  MAX_POLL_ATTEMPTS: 15,
  INITIAL_POLL_DELAY: 1000  // Start with 1 second
};

// --- TOKEN MANAGEMENT ---
let cachedToken = null;
let tokenExpiry = null;

async function getOAuthToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }
  console.log('Fetching OAuth token...');
  const tokenUrl = `${CONFIG.ORCHESTRATOR_URL}/identity_/connect/token`;
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
    throw new Error(`OAuth failed: ${response.status} - ${errorText}`);
  }
  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
  console.log('OAuth token obtained');
  return cachedToken;
}

// --- START JOB ---
async function startJob(inputData) {
  const token = await getOAuthToken();
  const startJobsUrl = `${CONFIG.ORCHESTRATOR_URL}/${CONFIG.ORCHESTRATOR_TENANT}/orchestrator_/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs`;
  
  const requestBody = {
    startInfo: {
      ReleaseKey: CONFIG.RELEASE_KEY,
      Strategy: 'ModernJobsCount',
      JobsCount: 1,
      InputArguments: JSON.stringify(inputData)
    }
  };

  console.log('Starting job with input:', inputData);

  const response = await fetch(startJobsUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-UIPATH-TenantName': CONFIG.ORCHESTRATOR_TENANT,
      'X-UIPATH-OrganizationUnitId': CONFIG.ORGANIZATION_UNIT_ID  // ✅ Confirmed working
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`StartJobs failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  if (!data.value || data.value.length === 0) {
    throw new Error('StartJobs returned no job information');
  }

  const jobKey = data.value[0].Key;
  console.log('Job started with Key:', jobKey);
  return jobKey;
}

// --- POLL FOR COMPLETION ---
async function pollJobCompletion(jobKey, attempt = 0) {
  if (attempt >= CONFIG.MAX_POLL_ATTEMPTS) {
    throw new Error(`Job did not complete within ${CONFIG.MAX_POLL_ATTEMPTS} attempts`);
  }

  const token = await getOAuthToken();
  const jobUrl = `${CONFIG.ORCHESTRATOR_URL}/${CONFIG.ORCHESTRATOR_TENANT}/orchestrator_/odata/Jobs?$filter=Key eq '${jobKey}'`;

  console.log(`Polling attempt ${attempt + 1}/${CONFIG.MAX_POLL_ATTEMPTS}...`);

  const response = await fetch(jobUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-UIPATH-TenantName': CONFIG.ORCHESTRATOR_TENANT,
      'X-UIPATH-OrganizationUnitId': CONFIG.ORGANIZATION_UNIT_ID  // ✅ No Content-Type on GET
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch job: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  if (!data.value || data.value.length === 0) {
    throw new Error('Job not found during polling');
  }

  const job = data.value[0];
  console.log(`Job state: ${job.State}`);

  if (job.State === 'Successful') {
    console.log('Job completed successfully!');
    console.log('Raw OutputArguments:', job.OutputArguments);

    if (!job.OutputArguments) {
      throw new Error('Job completed but has no OutputArguments');
    }

    // ✅ FIXED: Return directly - no double parsing needed
    const outputArgs = JSON.parse(job.OutputArguments);
    console.log('Final result:', outputArgs);
    return outputArgs;

  } else if (job.State === 'Faulted' || job.State === 'Stopped') {
    throw new Error(`Job failed with state: ${job.State}. Info: ${job.Info || 'No details'}`);

  } else {
    // Exponential backoff: 1s, 2s, 4s, 8s, 10s, 10s...
    const delay = Math.min(CONFIG.INITIAL_POLL_DELAY * Math.pow(2, attempt), 10000);
    console.log(`Job still running. Waiting ${delay / 1000}s before next poll...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    return await pollJobCompletion(jobKey, attempt + 1);
  }
}

// --- MAIN HANDLER ---
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

    const jobKey = await startJob({ date, time, duration });
    const result = await pollJobCompletion(jobKey);

    console.log('Success! Returning result:', result);
    return res.status(200).json(result);

  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({
      error: error.message,
      available: false,
      message: 'Unable to check availability. Please try again.'
    });
  }
};
