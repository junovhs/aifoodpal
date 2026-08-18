import { isoDate } from "./model";

export interface CalendarDay {
  date: string;
  day: number;
  inMonth: boolean;
}

const monthDate = (month: string): Date => {
  const [year = 1970, monthNumber = 1] = month.split("-").map(Number);
  return new Date(year, monthNumber - 1, 1, 12);
};

/** Returns the six-week Sunday-first grid used by the history calendar. */
export const calendarGrid = (month: string): CalendarDay[] => {
  const first = monthDate(month);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const value = isoDate(date);
    return { date: value, day: date.getDate(), inMonth: value.startsWith(month) };
  });
};

/** Shifts a YYYY-MM month key without UTC boundary drift. */
export const shiftMonth = (month: string, amount: number): string => {
  const date = monthDate(month);
  date.setMonth(date.getMonth() + amount);
  return isoDate(date).slice(0, 7);
};

export const formatMonth = (month: string): string =>
  new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(monthDate(month));
