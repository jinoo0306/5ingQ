import { LOL_CHAMPIONS_KR } from '../constants/champions';
import { LOL_LINES } from '../constants/lines';

export function getTodayRandomStatus(): string {
  // 매일 오전 9시를 기준으로 고정된 seed를 사용 (한국 시간)
  const now = new Date();
  const koreaTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const seedBase = `${koreaTime.getUTCFullYear()}-${koreaTime.getUTCMonth()}-${koreaTime.getUTCDate()}`;

  const hash = [...seedBase].reduce((acc, char) => acc + char.charCodeAt(0), 0);

  const line = LOL_LINES[hash % LOL_LINES.length];
  const champion = LOL_CHAMPIONS_KR[hash % LOL_CHAMPIONS_KR.length];

  return `${line} ${champion}`;
}
