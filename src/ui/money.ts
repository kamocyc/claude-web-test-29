/** Money is shown as whole yen with separators: no decimals anywhere. */
export function formatMoney(value: number): string {
  const rounded = Math.round(value);
  return `${rounded < 0 ? '-' : ''}¥${Math.abs(rounded).toLocaleString('ja-JP')}`;
}

export function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
