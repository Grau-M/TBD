// scripts/verify_logs.ts
// Run with: npx ts-node scripts/verify_logs.ts
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';

const SECRET_KEY = 'TBD_CAPSTONE_MASTER_KEY_2026';
const SALT = 'salty_buffer_tbd';
const KEY = crypto.scryptSync(SECRET_KEY, SALT, 32);

const logPath = path.join(__dirname, '../.vscode/tbd-integrity-log.enc'); // Adjust path as needed

try {
    const fileBuffer = fs.readFileSync(logPath);
    
    // Attempt Decrypt
    const iv = fileBuffer.subarray(0, 16);
    const content = fileBuffer.subarray(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
    const decrypted = Buffer.concat([decipher.update(content), decipher.final()]);
    
    console.log("✅ SUCCESS: Log file decrypted successfully.");
    console.log("Preview:", decrypted.toString().slice(0, 100));
} catch (error) {
    console.error("❌ FAILED: Could not decrypt log file.", error);
}