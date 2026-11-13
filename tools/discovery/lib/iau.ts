/** IAU Working Group on Star Names catalogue (IAU-CSN.txt). Fixed-width: name columns by position, numeric tail by regex. */
export const IAU_CSN_URL = 'https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt';

export interface IauName { name: string; nameAscii: string; designation: string; hip: number | null; hd: string; mag: number | null; line: string }

export function parseIauCsn(text: string): { names: IauName[]; lastUpdated: string | null; headerQuote: string[] } {
  const names: IauName[] = [];
  const header = text.split('\n').filter((l) => l.startsWith('#') || l.startsWith('$')).slice(0, 12).map((l) => l.replace(/^[#$]\s*/, ''));
  const upd = /Last updated (\d{4}-\d{2}-\d{2})/.exec(text);
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('$')) continue;
    const tail = /(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s*\S*\s*$/.exec(line);
    if (!tail) continue;
    const hipTok = tail[1]!;
    const nameAscii = line.slice(0, 18).trim();
    const name = line.slice(18, 36).trim();
    const designation = line.slice(36, 49).trim();
    const magM = /\s(\d+\.\d+|_)\s+[A-Za-z_]\s+\S+\s+\S+\s+\S+\s+\S+\s+\d{4}-/.exec(line.slice(49));
    names.push({
      name: name || nameAscii, nameAscii, designation,
      hip: /^\d+$/.test(hipTok) ? Number(hipTok) : null, hd: tail[2]!,
      mag: magM && magM[1] !== '_' ? Number(magM[1]) : null, line,
    });
  }
  return { names, lastUpdated: upd?.[1] ?? null, headerQuote: header };
}
