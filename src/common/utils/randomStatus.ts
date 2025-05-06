import { LOL_CHAMPIONS_KR } from '../constants/champions';
import { LOL_LINES } from '../constants/lines';

export function getTodayRandomStatus(): string {
  // 'Asia/Seoul' 타임존으로 날짜를 문자열로 추출 (예: "2025. 04. 02.")
  // const seoulDateStr = new Date().toLocaleDateString('ko-KR', {
  //   timeZone: 'Asia/Seoul',
  //   year: 'numeric',
  //   month: '2-digit',
  //   day: '2-digit',
  // });
  // seoulDateStr 예: "2025. 04. 02."

  // 모든 숫자와 구분자 제거하거나 원하는 형태로 정제
  // 예시로 구분자 '-'로 변경할 수 있습니다.
  // const seedBase = seoulDateStr.replace(/[^0-9]/g, ''); // 예: "20250402"

  // const hash = [...seedBase].reduce((acc, char) => acc + parseInt(char, 10), 0);

  // const line = LOL_LINES[hash % LOL_LINES.length];
  // const champion = LOL_CHAMPIONS_KR[hash % LOL_CHAMPIONS_KR.length];

  const line = LOL_LINES[Math.floor(Math.random() * LOL_LINES.length)];
  const champion =
    LOL_CHAMPIONS_KR[Math.floor(Math.random() * LOL_CHAMPIONS_KR.length)];

  return `${line} ${champion}`;
}
