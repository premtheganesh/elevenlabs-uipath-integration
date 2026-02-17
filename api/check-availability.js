// Check Availability - Best Practice: Server-Side Long-Polling
const fetch = require('node-fetch');

// Configuration
const CONFIG = {
  ORCHESTRATOR_URL: 'https://cloud.uipath.com/leaniar',
  ORCHESTRATOR_TENANT: 'default',
  FOLDER_KEY: 'f3a946f0-4c9a-479e-a63e-e4e82489dc02',  // From release info
  ORGANIZATION_UNIT_ID: 1075762,  // Numeric ID from release info
  RELEASE_KEY: '17da421f-3373-4ae7-bd9f-95fc6417d104',
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,
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

    const token = await getOAuthToken();
    const startJobsUrl = `${CONFIG.ORCHESTRATOR_URL}/${CONFIG.ORCHESTRATOR_TENANT}/orchestrator_/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs`;
    
    const requestBody = {
      startInfo: {
        ReleaseKey: CONFIG.RELEASE_KEY,
        Strategy: 'ModernJobsCount',
        JobsCount: 1,
        InputArguments: JSON.stringify({ date, time, duration }),
        RuntimeType: 'Unattended'
      }
    };
    
    console.log('Starting synchronous job...');
    console.log('Request body:', JSON.stringify(requestBody, null, 2));
    
    const response = await fetch(startJobsUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-UIPATH-TenantName': CONFIG.ORCHESTRATOR_TENANT,
        'X-UIPATH-OrganizationUnitId': CONFIG.ORGANIZATION_UNIT_ID.toString()
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('StartJobs Error:', errorText);
      throw new Error(`StartJobs failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('Response from UiPath:', JSON.stringify(data, null, 2));
    
    if (data.value && data.value.length > 0) {
      const job = data.value[0];
      console.log('Job state:', job.State);
      
      if (job.State === 'Successful') {
        console.log('Raw OutputArguments:', job.OutputArguments);
        
        if (!job.OutputArguments) {
          throw new Error('Job completed but has no OutputArguments');
        }
        
        const outputArgs = JSON.parse(job.OutputArguments);
        console.log('Parsed OutputArguments:', outputArgs);
        
        // The output is directly in the outputArgs object based on your Response activity
        const result = outputArgs;
        
        console.log('Success! Returning result to client:', result);
        return res.status(200).json(result);
        
      } else if (job.State === 'Faulted' || job.State === 'Stopped') {
        console.error('Job failed. Info:', job.Info);
        throw new Error(`Job failed with state: ${job.State}. Info: ${job.Info || 'No details'}`);
        
      } else {
        // Job is still pending/running - shouldn't happen with synchronous call
        throw new Error(`Unexpected job state: ${job.State}`);
      }
    } else {
      throw new Error('StartJobs returned no job information');
    }

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: error.message,
      available: false,
      message: 'Unable to check availability. Please try again.'
    });
  }
};
