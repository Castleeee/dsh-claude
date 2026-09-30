/** Text Claude Code prints when it could not run a model turn at all.
 *
 *  The CLI reports that failure as a *successful* result whose `result` field is
 *  this message, so every caller that turns a reply into a label has to
 *  recognize it. It is how a session came to be named "Not logged in · Please
 *  run /login", and a branch name was one slugify() away from the same fate.
 *
 *  Matching anywhere in the reply is deliberate: a false positive costs one
 *  caller's deterministic fallback label, while a miss puts an authentication
 *  error where a name belongs. */
const CLI_FAILURE_REPLY = /not logged in|please run \/login|invalid api key/iu

/** Whether a model reply is really the CLI reporting that it could not run. */
export function isCliFailureReply(reply: string): boolean {
  return CLI_FAILURE_REPLY.test(reply)
}
