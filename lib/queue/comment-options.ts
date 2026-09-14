// Webhooks and polling use different job IDs but must share one in-flight
// comment. BullMQ keeps this key through retries and manual delays, releasing
// it only once the job completes or permanently fails.
export function commentDeduplication(instagramAccountId: string, commentId: string) {
  return { id: `comment_${instagramAccountId}_${commentId}` };
}
