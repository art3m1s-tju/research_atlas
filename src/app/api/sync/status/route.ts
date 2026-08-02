import { NextResponse } from "next/server";
import { readSyncStatus } from "@/lib/sync-status";
import { readSyncCheckpoints } from "@/lib/sync-checkpoint";

export async function GET() {
  return NextResponse.json({ status: readSyncStatus(), checkpoints: readSyncCheckpoints() });
}
