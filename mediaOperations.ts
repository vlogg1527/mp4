"use strict";
import { execSync } from 'child_process';
import * as path from 'path';

function getVideoMetadata(filePath: string): any {
    try {
        const command = `ffprobe -v quiet -print_format json -show_streams ${filePath}`;
        const output = execSync(command).toString();
        return JSON.parse(output);
    } catch (error) {
        console.error(`Error getting metadata for file ${filePath}`, error);
        return null;
    }
}

function checkVideoResolution(outputFilePath: string): number | null {
    const metadata = getVideoMetadata(outputFilePath);

    if (metadata && metadata.streams) {
        const videoStream = metadata.streams.find((stream: any) => stream.codec_type === 'video');

        if (videoStream) {
            const height = videoStream.height;
            console.log(`The video has a height of ${height} pixels.`);
            return height;
        } else {
            console.log("No video stream found in the file.");
        }
    }

    return null;
}

export function convertSegmentsToFileList(id: number, fileListPath: string, client: any) {
    console.log(`เริ่มแปลงไฟล์ ${id}.mp4'`);
    const outputFilePath = path.join('downloads', `${id}.mp4`);
    execSync(`ffmpeg -f concat -safe 0 -i ${fileListPath} -c copy ${outputFilePath}`);
    console.log(`แปลงไฟล์ ${id}.mp4 เสร็จแล้ว'`);
    const height = checkVideoResolution(outputFilePath);

    if (height !== null) {
        // Update the qualities in the database
        client.query('UPDATE hlsmp4 SET qualities = $1 WHERE id = $2', [height, id]);
    }
}
