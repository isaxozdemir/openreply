/**
 * Status label for DM status. Plain text; color carries the state.
 */

const statusConfig: Record<string, { text: string; label: string }> = {
  SENT: { text: "text-success", label: "Sent" },
  FAILED: { text: "text-error", label: "Failed" },
  PENDING: { text: "text-warning", label: "Pending" },
  SKIPPED_DEDUP: { text: "text-muted", label: "Dedup" },
  SKIPPED_RATE_LIMIT: { text: "text-warning", label: "Rate limited" },
  SKIPPED_PLAN_LIMIT: { text: "text-warning", label: "Skipped" },
  SKIPPED_NO_MATCH: { text: "text-muted", label: "No match" },
  // The prompt went out, the link did not. Worth a colour of its own: these
  // are people still waiting, not people who were served.
  SKIPPED_FOLLOW_GATE: { text: "text-warning", label: "Follow gate" },
  // WebhookStatus, shown on the diagnostics delivery list.
  PROCESSED: { text: "text-success", label: "Processed" },
};

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.PENDING;

  return (
    <span className={`shrink-0 whitespace-nowrap text-sm ${config.text}`}>
      {config.label}
    </span>
  );
}
