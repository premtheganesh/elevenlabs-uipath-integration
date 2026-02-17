// Check Availability - StartJobs Synchronous Pattern
const fetch = require('node-fetch');

// Configuration
const CONFIG = {
  ORCHESTRATOR_URL: 'https://cloud.uipath.com/leaniar',
  ORCHESTRATOR_TENANT: 'default',
  FOLDER_KEY: 'f3a946f0-4c9a-479e-a63e-e4e82489dc02',
  RELEASE_KEY: '17da421f-3373-4ae7-bd9f-95fc6417d104',
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,
  MAX_POLL_ATTEMPTS: 30
};

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
    console.error('OAuth Error:', errorText);
    throw new Error(`OAuth failed: ${response.status}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
  
  console.log('OAuth token obtained');
  return cachedToken;
}

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
  
  console.log('Starting job via StartJobs API...');
  console.log('Input data:', inputData);
  
  const response = await fetch(startJobsUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-UIPATH-TenantName': CONFIG.ORCHESTRATOR_TENANT,
      'X-UIPATH-FolderKey': CONFIG.FOLDER_KEY
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('StartJobs Error:', errorText);
    throw new Error(`StartJobs failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  if (data.value && data.value.length > 0) {
    const job = data.value[0];
    console.log('Job started with Key:', job.Key);
    return job.Key;
  } else {
    throw new Error('StartJobs returned no job information');
  }
}

async function pollJobCompletion(jobKey, attempt = 0) {
  const token = await getOAuthToken();
  
  // FIXED: Use simple string comparison instead of guid syntax
  const jobUrl = `${CONFIG.ORCHESTRATOR_URL}/${CONFIG.ORCHESTRATOR_TENANT}/orchestrator_/odata/Jobs?$filter=Key eq '${jobKey}'`;
  
  console.log(`Polling attempt ${attempt + 1}/${CONFIG.MAX_POLL_ATTEMPTS}`);
  console.log('URL:', jobUrl);
  
  const response = await fetch(jobUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-UIPATH-TenantName': CONFIG.ORCHESTRATOR_TENANT,
      'X-UIPATH-FolderKey': CONFIG.FOLDER_KEY
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Failed to fetch job:', response.status, errorText);
    throw new Error(`Failed to fetch job: ${response.status}`);
  }

  const data = await response.json();
  
  if (!data.value || data.value.length === 0) {
    console.error('Job not found in response:', data);
    throw new Error('Job not found');
  }

  const job = data.value[0];
  console.log(`Job state: ${job.State}`);
  
  if (job.State === 'Successful') {
    console.log('Job completed successfully!');
    console.log('Raw OutputArguments:', job.OutputArguments);
    
    if (!job.OutputArguments) {
      throw new Error('Job completed but has no OutputArguments');
    }
    
    const outputArgs = JSON.parse(job.OutputArguments);
    console.log('Parsed OutputArguments:', outputArgs);
    
    // Parse the output string (which contains our JSON)
    const result = JSON.parse(outputArgs.output);
    console.log('Final result:', result);
    
    return result;
    
  } else if (job.State === 'Faulted' || job.State === 'Stopped') {
    console.error('Job failed. Info:', job.Info);
    throw new Error(`Job failed with state: ${job.State}. Info: ${job.Info || 'No details'}`);
    
  } else if (attempt >= CONFIG.MAX_POLL_ATTEMPTS) {
    throw new Error(`Job did not complete within ${CONFIG.MAX_POLL_ATTEMPTS} attempts`);
    
  } else {
    // Job still running, wait and retry
    await new Promise(resolve => setTimeout(resolve, 2000));
    return await pollJobCompletion(jobKey, attempt + 1);
  }
}

module.exports = async (req, res) => {
  // CORS
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

    // Start job
    const jobKey = await startJob({ date, time, duration });
    
    // Poll for completion and get result
    const result = await pollJobCompletion(jobKey);

    console.log('Success! Returning result to client');
    return res.status(200).json(result);

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: error.message,
      available: false,
      message: 'Unable to check availability. Please try again.'
    });
  }
};
