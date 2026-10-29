// Complete relative-departure labels shared by results and the board. Their
// catchability/departed flags control styling, not grammar: the one-minute
// search grace period can still label a train catchable after its time passed.
export function departureText(depAbs, mNow) {
  const diff = Math.round(depAbs - mNow);
  if (diff === 0) return "leaving now";
  const minutes = Math.abs(diff);
  const duration =
    minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return diff > 0 ? `departs in <b>${duration}</b>` : `<b>departed</b> ${duration} ago`;
}
