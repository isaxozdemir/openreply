// These failures can leave an empty private-reply thread. A new inbound DM is
// the recovery path; neither a read receipt nor a rejected retry proves delivery.
export function canRecoverPrivateReply(errorMessage: string | null | undefined): boolean {
  return /sub=(2534025|1545133)\b|invalid for a private reply|service temporarily unavailable/i.test(errorMessage ?? "");
}

export const DM_RECOVERY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_DM_RECOVERY_MESSAGE = "Mesaj ulaşmadıysa bana DM’den {keyword} yaz.";
