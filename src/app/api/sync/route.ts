import { NextResponse } from "next/server";
import { exec } from "child_process";
import path from "path";

export async function POST() {
  return new Promise<NextResponse>((resolve) => {
    const scriptPath = path.join(process.cwd(), "scripts", "sync-multi-source.ts");
    exec(`npx tsx ${scriptPath}`, { cwd: process.cwd() }, (error, stdout, stderr) => {
      if (error) {
        console.error("Sync error:", error);
        resolve(NextResponse.json({ 
          success: false, 
          error: stderr || error.message 
        }, { status: 500 }));
        return;
      }
      
      console.log("Sync output:", stdout);
      resolve(NextResponse.json({ 
        success: true, 
        message: "同步完成",
        output: stdout 
      }));
    });
  });
}
