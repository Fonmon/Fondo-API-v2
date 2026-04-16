function isLastDayOfMonth(date: Date): boolean {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  next.setUTCDate(next.getUTCDate() - 1);
  return date.getUTCDate() === next.getUTCDate();
}

export function days360(startDate: Date, endDate: Date, europeanMethod = false): number {
  if (startDate.getTime() === endDate.getTime()) return 0;

  let start = startDate;
  let end = endDate;

  if (end < start) {
    start = endDate;
    end = startDate;
  }

  let startDay = start.getUTCDate();
  let endDay = end.getUTCDate();

  if (europeanMethod) {
    startDay = Math.min(startDay, 30);
    endDay = Math.min(endDay, 30);
  } else {
    // US NASD method
    if (isLastDayOfMonth(start)) startDay = 30;
    if (startDay === 30 && endDay === 31) endDay = 30;
  }

  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * 360 +
    (end.getUTCMonth() - start.getUTCMonth()) * 30 +
    (endDay - startDay)
  );
}
