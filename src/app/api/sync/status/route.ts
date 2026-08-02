import { NextResponse } from "next/server";
import { readSyncStatus } from "@/lib/sync-status";

export async function GET() {
  return NextResponse.json({ status: readSyncStatus() });
}
