// dl.js
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const ffmpeg = require('fluent-ffmpeg');
const url = require('url');
const https = require('https');
// Initialize the PostgreSQL connection pool
const pool = require('./db/config');
const DOWNLOAD_PATH = './downloads/';

const credentials = JSON.parse(fs.readFileSync(process.env.CREDENTIALS_PATH || './.credentials/credentials.json', 'utf8'));
const { client_id, client_secret, redirect_uris } = credentials.installed;

const oauth2Client = new OAuth2Client(
  client_id,
  client_secret,
  redirect_uris[0]
);

// Function to upload a file to Google Drive
async function uploadFileToDrive(fileId, filePath, downloadPath) {
  // Retrieve the Google Drive folder ID and refresh token from the database
  const result = await pool.query('SELECT * FROM google_tokens');
  const { folder_id, refresh_token } = result.rows[0];

  // Set OAuth2 credentials
  oauth2Client.setCredentials({
    refresh_token: refresh_token,
  });

  // Initialize Google Drive API
  const drive = google.drive({
    version: 'v3',
    auth: oauth2Client,
  });

  const client = await pool.connect();
  try {
    const fileExtension = path.extname(filePath).toLowerCase();
    const mimeTypesMap = {
      '.mp4': 'video/mp4',
      '.ts': 'video/MP2T',
      '.mkv': 'video/x-matroska',
    };
    const mimeType = mimeTypesMap[fileExtension] || 'application/octet-stream';

    const fileNameWithExtension = `${fileId}${fileExtension}`;
    const fileMetadata = {
      'name': fileNameWithExtension,
      'parents': [folder_id],
      'mimeType': mimeType,
    };
    const media = {
      mimeType: mimeType,
      body: fs.createReadStream(filePath),
    };

    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id,size',
    });

    const driveId = driveResponse.data.id;
    const fileSize = driveResponse.data.size;
    fs.unlinkSync(downloadPath);

    await client.query('UPDATE hlsmp4 SET drive_id = $1, filesize = $2, status = $3 WHERE id = $4', [driveId, fileSize, '1', fileId]);
    console.log(`update link MP4 status: ${fileId}`); // Corrected 'id' to 'fileId'

    await drive.permissions.create({
      fileId: driveId,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    console.log(`File uploaded to Google Drive with ID: ${driveId}`);
    return Promise.resolve();
  } catch (error) {
    console.error('Error uploading file to Google Drive:', error);
  } finally {
    client.release();
  }
}

const ensureDirectoryExists = (filePath) => {
  const dirname = path.dirname(filePath);
  if (fs.existsSync(dirname)) {
    return true;
  }
  ensureDirectoryExists(dirname);
  fs.mkdirSync(dirname);
};

async function downloadFileMP4(url, downloadPath, id) {
  const client = await pool.connect(); // Assuming you have a 'pool' defined
  try {
    await client.query('UPDATE hlsmp4 SET status = $1 WHERE id = $2', ['2', id]);
    console.log(`update link MP4 status :${id}`);
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: 5000, // 5 seconds timeout
      headers: {
        'Referer': 'https://sub-thai.com/', // Add the Referer header here
      },
    });

    ensureDirectoryExists(downloadPath);

    const totalLength = response.headers['content-length'];

    console.log(`Starting download: Total size = ${totalLength} bytes.`);

    let downloadedLength = 0;

    const writer = fs.createWriteStream(downloadPath);

    response.data.on('data', (chunk) => {
      downloadedLength += chunk.length;
      const progress = (downloadedLength / totalLength * 100).toFixed(2);
      process.stdout.clearLine();
      process.stdout.cursorTo(0);
      process.stdout.write(`Downloading... ${progress}%`);
    });

    response.data.on('end', () => {
      console.log('\nDownload complete.');
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (err) {
    console.error(`Error downloading file: ${err}`);
    throw err;
  } finally {
    client.release();
  }
}




  
  
const getPlaylist = async (playlistUrl) => {
  try {
    const response = await axios.get(playlistUrl);
    return response.data;
  } catch (error) {
    console.error(`Error fetching playlist:`, error);
    throw error;
  }
};

const createFilesTxt = (DOWNLOAD_PATH,id) => {
  const tsFiles = fs.readdirSync(DOWNLOAD_PATH).filter(file => file.endsWith('.ts'));
  tsFiles.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const listContent = tsFiles.map(file => `file '${file}'`).join('\n');
  fs.writeFileSync(path.join(DOWNLOAD_PATH, `files_${id}.txt`), listContent);
};

const convertToMp4 = (DOWNLOAD_PATH, outputFileNamenew,id) => {
  return new Promise((resolve, reject) => {
    const listFilePath = path.join(DOWNLOAD_PATH, `files_${id}.txt`);
    const outputFilePath = path.join(DOWNLOAD_PATH, outputFileNamenew);
    const ffmpegCommand = `ffmpeg -f concat -safe 0 -i ${listFilePath} -c copy -y ${outputFilePath}`;

    const ffmpegProcess = exec(ffmpegCommand, (error, stdout, stderr) => {
      if (error) {
        console.error('Error during conversion:', error);
        console.error('FFmpeg stderr:', stderr);
        reject(error);
        return;
      }
      console.log('Conversion to MP4 completed.');
      resolve();
    });
  });
};

const downloadFile = async (fileUrl, filePath) => {
  try {
    const response = await axios.get(fileUrl, { responseType: 'stream' });
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    console.error(`Error downloading or saving file:`, error);
    throw error;
  }
};

const checkFileUrlStatus = async (fileUrl, maxRetries = 3, retryDelay = 1000) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await axios.head(fileUrl);
      return response.status;
    } catch (error) {
      console.error(`Error checking file URL status:`, error);
      if (error.response && [403, 502, 401, 400].includes(error.response.status)) {
        console.log(`Retrying in ${retryDelay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        throw error;
      }
    }
  }
  throw new Error('Max retries reached. Unable to fetch file URL status.');
};


const convertM3U8ToMP4 = async (m3u8Link, DOWNLOAD_PATH, id) => {
  const client = await pool.connect(); // Assuming you have a 'pool' defined
  try {
    await client.query('UPDATE hlsmp4 SET status = $1 WHERE id = $2', ['2', id]);
    console.log(`update status link M3U8 :${id}`);
    const listFilePath = path.join(DOWNLOAD_PATH, `files_${id}.txt`);
    const outputFileNamenew = `${id}.mp4`;


      // Fetch master m3u8 file
      const m3u8Data = await getPlaylist(m3u8Link);
      const variantUrlMatch = m3u8Data.match(/(http[^\n]+|\/[^\n]+)/);
      if (!variantUrlMatch) throw new Error('No variant stream URL found in the master m3u8 data.');
      const variantUrl = url.resolve(m3u8Link, variantUrlMatch[0]);
      const variantM3u8Data = await getPlaylist(variantUrl);
      const segmentUrls = variantM3u8Data.match(/(http[^\n]+\.(ts|html|png|jpg|webp|txt)|[^\n]+\.(ts|html|png|jpg|webp|txt))/g);
      if (!segmentUrls) throw new Error('No segment URLs found in the m3u8 data.');

      const downloadSegments = async (segmentUrls, DOWNLOAD_PATH, id, maxConcurrentDownloads = 5, maxRetries = 3, retryDelay = 1000) => {
        const downloadQueue = [...segmentUrls.entries()];
        let activeDownloads = 0;
      
        return new Promise((resolve, reject) => {
          const attemptDownload = async () => {
            if (downloadQueue.length === 0 && activeDownloads === 0) {
              resolve();
              return;
            }
      
            while (activeDownloads < maxConcurrentDownloads && downloadQueue.length > 0) {
              const [index, segmentUrl] = downloadQueue.shift();
              activeDownloads++;
      
              try {
                const filePath = path.join(DOWNLOAD_PATH, `${id}_${index}.ts`);
                await downloadFileWithRetry(segmentUrl, filePath, maxRetries, retryDelay);
                console.log(`Segment ${index + 1} of ${segmentUrls.length} downloaded.`);
              } catch (error) {
                console.error(`Error downloading segment ${index + 1}:`, error.message);
              } finally {
                activeDownloads--;
                attemptDownload();
              }
            }
          };
      
          attemptDownload().catch(reject);
        });
      };
      
      const downloadFileWithRetry = async (fileUrl, filePath, maxRetries, retryDelay) => {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            const response = await axios.get(fileUrl, { responseType: 'stream' });
            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
              writer.on('finish', resolve);
              writer.on('error', reject);
            });
            return;
          } catch (error) {
            console.error(`Error downloading or saving file on attempt ${attempt + 1}:`, error.message);
            if (error.response && [403, 502, 401, 400].includes(error.response.status)) {
              console.log(`Retrying in ${retryDelay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
              await new Promise(resolve => setTimeout(resolve, retryDelay));
            } else {
              throw error;
            }
          }
        }
        throw new Error('Max retries reached. Unable to download file.');
      };
      
      // Usage
      await downloadSegments(segmentUrls, DOWNLOAD_PATH, id, 10);

      // Create files.txt
      createFilesTxt(DOWNLOAD_PATH,id);
 

 // Convert to MP4
 await convertToMp4(DOWNLOAD_PATH, outputFileNamenew,id);

 // Delete .ts and .txt files
 fs.unlinkSync(listFilePath); // Delete files.txt
 console.log(`Deleted files_${id}.txt`);

 const tsFiles = fs.readdirSync(DOWNLOAD_PATH).filter(file => file.endsWith('.ts'));
 tsFiles.forEach(file => {
   fs.unlinkSync(path.join(DOWNLOAD_PATH, file)); // Delete .ts files
 });
 console.log('Deleted .ts files.');

} catch (error) {
 console.error(`Error in convertM3U8ToMP4:`, error);
}
};



// Function to download a single pending file, process it, and upload to Google Drive
async function downloadAndProcessFile() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Start a transaction
    
   // Check if there are any outstanding files with status = 2
   const outstandingFiles = await client.query("SELECT * FROM hlsmp4 WHERE status = '2';");
   if (outstandingFiles.rows.length > 0) {
     console.log('There are outstanding files. Deleting them...');
     // Loop through outstanding files and delete them
     for (const outstandingFile of outstandingFiles.rows) {
       const fileIdToDelete = outstandingFile.id;
       const deleteContentsOfDirectory = (directoryPath) => {
        try {
          const items = fs.readdirSync(directoryPath);
      
          for (const item of items) {
            const itemPath = path.join(directoryPath, item);
            const itemStats = fs.statSync(itemPath);
      
            if (itemStats.isDirectory()) {
              fs.rmdirSync(itemPath, { recursive: true });
              console.log(`Deleted directory: ${itemPath}`);
            } else {
              fs.unlinkSync(itemPath);
              console.log(`Deleted file: ${itemPath}`);
            }
          }
          console.log('All contents of the directory have been deleted.');
        } catch (error) {
          console.error(`Error deleting contents of the directory: ${error.message}`);
        }
      };
      
      deleteContentsOfDirectory(DOWNLOAD_PATH);
     }
   }


   // Reset any stuck or working links
   //await client.query("UPDATE hlsmp4 SET status = '0' WHERE status = '1';");
   //console.log('Reset stuck or working links.');

   // Fetch the first pending file
   const result = await client.query("SELECT * FROM hlsmp4 WHERE status = '0' ORDER BY time DESC LIMIT 1;");
   const pendingFile = result.rows[0];

   if (pendingFile) {
     const { id, link, type } = pendingFile;
     const downloadPath = `${DOWNLOAD_PATH}${id}.mp4`;

     try {
       // Mark the file as being worked on
       //await client.query("UPDATE hlsmp4 SET status = '0' WHERE id = $1;", [id]);
       //console.log(`Set status to working for link: ${id}`);

       if (type === 'MP4') {
         await downloadFileMP4(link, downloadPath, id);
         console.log('MP4 Download successful.');
       } else if (type === 'M3U8') {
         await convertM3U8ToMP4(link, DOWNLOAD_PATH, id);
         console.log('M3U8 Download successful.');
       }

        // Use FFmpeg to get video metadata
       ffmpeg.ffprobe(downloadPath, async (err, metadata) => {
  if (err) {
    console.error('Error reading file:', err);

    try {
      const files = fs.readdirSync(downloadPath);
      for (const file of files) {
        if (path.extname(file) === '.txt' || path.extname(file) === '.ts') {
          fs.unlinkSync(path.join(downloadPath, file));
          console.log(`Deleted file: ${file}`);
           await pool.query('UPDATE hlsmp4 SET status = $1 WHERE id = $2', ['0', id]);
        console.log(`Update status status: 0`);
        }
      }
    } catch (deleteErr) {
      console.error('Error deleting files:', deleteErr);
    }
  } else {
    const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
    if (videoStream) {
      const height = videoStream.height;
      // Assuming you have 'qualities' defined somewhere
      const qualities = height;

      try {
        await pool.query('UPDATE hlsmp4 SET qualities = $1 WHERE id = $2', [qualities, id]);
        console.log(`Update status qualities: ${qualities}`);
        console.log(`Video height: ${height} pixels`);
      } catch (updateError) {
        console.error('Error updating qualities:', updateError);
      }
    } else {
      console.error('No video stream found in the input file.');
    }
  }
});


        const fileId = id;
        const filePath = path.join(DOWNLOAD_PATH, `${fileId}.mp4`);

        // Call the uploadFileToDrive function and wait for it to complete
        await uploadFileToDrive(fileId, filePath, downloadPath);

        // Mark the processed file as '1' (processed) in the database
        await client.query('UPDATE hlsmp4 SET status = $1 WHERE id = $2', ['1', id]);
        console.log(`Marked link as processed: ${id}`);

      } catch (downloadError) {
        console.error('Error processing file:', downloadError);
        // Mark the file as '3' (error) in the database

     // Loop through outstanding files and delete them
      const fileIdToDelete = id;
       const filePathToDelete = path.join(DOWNLOAD_PATH, `${fileIdToDelete}.mp4`);
       
       // Delete the local file
       fs.unlinkSync(filePathToDelete);
        await client.query('UPDATE hlsmp4 SET status = $1 WHERE id = $2', ['3', id]);
        console.log(`Marked link as error: ${id}`);
      }
    }

    await client.query('COMMIT'); // Commit the transaction
  } catch (err) {
    await client.query('ROLLBACK'); // Rollback the transaction in case of an error
    console.error('An error occurred:', err);
  } finally {
    client.release();
  }
}

// Function to repeatedly download and process files every 10 seconds
async function processPendingFiles() {
  while (true) {
    await downloadAndProcessFile(); // Process one file at a time
    await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds
  }
}

// Export the processPendingFiles function
module.exports.processPendingFiles = processPendingFiles;

// Start processing files
processPendingFiles();
