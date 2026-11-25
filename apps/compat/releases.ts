export const releaseSource = 'https://kubernetes.io/releases/';

const maintenance: Partial<Record<number, string>> = {
  35: '2026-12-28', 36: '2027-04-28', 37: '2027-08-28',
};
const endOfLife: Partial<Record<number, string>> = {
  16: '2020-09-02', 17: '2021-01-13', 18: '2021-06-18', 19: '2021-10-28',
  20: '2022-02-28', 21: '2022-06-28', 22: '2022-12-08', 23: '2023-02-28',
  24: '2023-07-28', 25: '2023-10-28', 26: '2024-02-28', 27: '2024-07-16',
  28: '2024-10-22', 29: '2025-02-28', 30: '2025-07-15', 31: '2025-11-11',
  32: '2026-02-28', 33: '2026-06-28', 34: '2026-10-27', 35: '2027-02-28',
  36: '2027-06-28', 37: '2027-10-28',
};

export function releaseStatus(minor: number, today: string) {
  const eol = endOfLife[minor] ?? null;
  const maintenanceStart = maintenance[minor] ?? null;
  const status = !eol ? 'unknown' : today >= eol ? 'eol'
    : maintenanceStart && today >= maintenanceStart ? 'maintenance' : 'supported';
  return { status, endOfLife: eol, sourceUrl: releaseSource };
}
