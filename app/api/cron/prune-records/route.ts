import { NextRequest, NextResponse } from "next/server";
import { pruneExpiredRecords, RETENTION_DAYS } from "@/lib/ops/retention";

/**
 * Deletes records past their retention window.
 *
 * Without this the append-only tables — WebhookEvent above all, which stores a
 * full Meta payload per delivery — grow until the database volume fills. A full
 * volume makes Postgres reject writes, which the app surfaces as 500s rather
 * than as anything that points at disk.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    const deleted = await pruneExpiredRecords();
    return NextResponse.json({
      success: true,
      deleted,
      retentionDays: RETENTION_DAYS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Cron] Record pruning failed:", message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
