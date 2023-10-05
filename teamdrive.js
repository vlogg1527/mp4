const express = require('express');
const router = express.Router();
const bodyParser = require('body-parser');
const pool = require('../db/config');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { google } = require('googleapis');
const OAuth2 = google.auth.OAuth2;
// Middleware
router.use(bodyParser.urlencoded({ extended: true }));
router.use(bodyParser.json());

const credentials = JSON.parse(fs.readFileSync('./.credentials/credentials.json', 'utf8'));
const { client_id, client_secret,redirect_uris } = credentials.installed;

router.get('/', (req, res) => {
  res.render('func/teamdrive', {
    title: 'Unlimited Google Drive Accounts',
    client_id: client_id,
    client_secret: client_secret,
  });
});


router.post('/api/add', async (req, res) => {
    const { email } = req.body;
    const uid = uuidv4();
  
    try {
      // Check if email is empty or not provided
      if (!email || email.trim() === '') {
        res.json({ status: 'error', message: 'Email cannot be empty' });
        return;
      }
  
      const checkResult = await pool.query(
        'SELECT * FROM google_tokens WHERE google_email = $1',
        [email]
      );
  
      if (checkResult.rows.length > 0) {
        res.json({ status: 'error', message: 'Email already exists' });
        return;
      }
  
      const insertResult = await pool.query(
        'INSERT INTO google_tokens (id, google_email) VALUES ($1, $2) RETURNING *',
        [uid, email]
      );
  
      res.json({ status: 'success', message: `Email added with email: ${insertResult.rows[0].google_email}` });
    } catch (err) {
      console.error(err);
      res.json({ status: 'error', message: 'Error adding email' });
    }
  });



  router.get('/api/list', async (req, res) => {
    try {
      // Load credentials
      const credentials = JSON.parse(fs.readFileSync('./.credentials/credentials.json', 'utf8'));
      const { client_id, client_secret, redirect_uris } = credentials.installed;
  
      // Fetch data from database
      const googleTokensResult = await pool.query('SELECT * FROM google_tokens');
      const hlsmp4Result = await pool.query('SELECT SUM(CAST(filesize AS bigint)) AS totalFileSize FROM hlsmp4 WHERE status = $1', [1]);
  
      const googleTokensData = googleTokensResult.rows;
      const totalFileSize = hlsmp4Result.rows[0].totalfilesize;
  
      // Check for data validity
      if (!googleTokensData.length) {
        console.error('No data in googleTokensData');
        return res.status(500).json({ status: 'error', message: 'No Google tokens found' });
      }
  
      // Setup OAuth2 client
      const oauth2Client = new OAuth2(client_id, client_secret, redirect_uris[0]);
      const refresh_token = googleTokensData[0].refresh_token;
  
      if (!refresh_token) {
        console.error('No refresh_token available');
      } else {
        oauth2Client.setCredentials({ refresh_token });
      }
  
      // Fetch data from Google Drive API
      let usage = null;
      if (refresh_token) {
        const drive = google.drive({ version: 'v3', auth: oauth2Client });
        const response = await drive.about.get({ fields: 'storageQuota' });
        usage = response.data.storageQuota.usageInDrive;
      }
  
      // Process and respond with data
      const selectedGoogleTokensData = googleTokensData.map(item => {
        if (item.status === null) {
          console.log('Status is NULL for item with id:', item.id);
        }
  
        return {
          id: item.id,
          google_email: item.google_email,
          status: item.status,
          folder_id: item.folder_id,
          limit: item.limit,
          status_limit: item.status_limit,
          mail_totalFileSize: totalFileSize,
          usage_drive: usage
        };
      });
  
      const responseData = {
        status: 'success',
        googleTokens: selectedGoogleTokensData,
      };
  
      res.json(responseData);
    } catch (err) {
      console.error(err);
      res.status(500).json({ status: 'error', message: 'Error fetching data' });
    }
  });


  router.post('/api/removeOauth', async (req, res) => {
    // Retrieve the email to be removed from the request body
    const { email } = req.body;
  
    try {
     await pool.query('DELETE FROM google_tokens WHERE google_email = $1', [email]);
  
      // Send a success response
      res.json({ status: 'success', message: `Email ${email} removed successfully` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ status: 'error', message: 'Error removing email' });
    }
  });



// Initialize OAuth2 client
const oauth2Client = new OAuth2(
    client_id,
    client_secret,
    redirect_uris[0], // This is your redirect URL
  );
  

  router.get('/auth', async (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/userinfo.email']
    });
    res.redirect(authUrl);
  });
  


  router.get('/api/oauth2callback', async (req, res) => {
    try {
      // Get the authorization code from the query string

      const code = req.query.code;
      const { tokens } = await oauth2Client.getToken(code);
      
      const access_token = tokens.access_token;
      const refresh_token = tokens.refresh_token;
      const expiry_date = tokens.expiry_date;
      
     
      oauth2Client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      const email = userInfo.data.email;
      console.log(email);
      const query = 'SELECT google_email FROM google_tokens WHERE google_email = $1';
      const emailCheck = await pool.query(query, [email]);
  
      if (emailCheck.rows.length > 0) {
  
         // Create a Google Drive folder
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const fileMetadata = {
      'name': 'TOOLSMP4',
      'mimeType': 'application/vnd.google-apps.folder'
    };

    const driveRes = await drive.files.create({
      resource: fileMetadata,
      fields: 'id'
    });

    console.log(`Folder created with ID: ${driveRes.data.id}`);

    await pool.query('UPDATE google_tokens SET access_token = $1, refresh_token = $2, status = $4, folder_id = $5, expiry_date = $6 WHERE google_email = $3', [access_token, refresh_token, email, '1', driveRes.data.id, expiry_date]);
    res.send(`
    <html>
      <body>
        <h1>Authentication successful</h1>
        <script>
          setTimeout(function() {
            window.close();
          }, 2000); // Close the window after 2 seconds (adjust as needed)
        </script>
      </body>
    </html>
  `);
      } else {
        res.send('Email not authorized.');
      }
    } catch (error) {
      console.error('An error occurred:', error);
      res.send('Authentication failed');
    }
  });


// Export the router
module.exports = router;