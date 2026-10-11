/** "#3": which recording this is in the order they came in, or nothing when it has no number. */
export const recordingTag = (summary: { sequence?: number }): string => (summary.sequence ? `#${summary.sequence}` : "");
