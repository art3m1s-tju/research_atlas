import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { ensureResearchFeatureSchema } from "@/lib/research-features";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

export async function GET() {
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const settings = db.prepare("SELECT enabled, channel, destination, updated_at FROM notification_settings WHERE id = 1").get() || { enabled: false, channel: "file", destination: "", updated_at: null };
    return NextResponse.json({ settings: { ...settings, enabled: Boolean((settings as any).enabled) }, secretsConfigured: { webhook: Boolean(process.env.DIGEST_WEBHOOK_URL), telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) } });
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const enabled = body.enabled !== false;
  const channel = ["file", "webhook", "telegram"].includes(body.channel) ? body.channel : "file";
  const destination = typeof body.destination === "string" ? body.destination.trim().slice(0, 500) : "";
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    db.prepare(`
      INSERT INTO notification_settings (id, enabled, channel, destination, updated_at)
      VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, channel = excluded.channel, destination = excluded.destination, updated_at = CURRENT_TIMESTAMP
    `).run(enabled ? 1 : 0, channel, destination);
    return NextResponse.json({ success: true, enabled, channel, destination });
  } finally {
    db.close();
  }
}
