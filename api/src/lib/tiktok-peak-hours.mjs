// Owner 23.11.2026: only audience peaks after 09:00 Asia/Yerevan.
// TikTok account @dasbroadcast, audience_activity 01–21.11.2026 (UTC),
// converted to UTC+4. Keep existing 90-minute starts inside the peak plateau.
export const PEAK_POLICY_VERSION='tiktok-peaks-2026-11-23';
export const YEREVAN_SCHEDULE={weekdays:['16:00','17:30','19:00'],weekends:['14:00','15:30','17:00','18:30','20:00']};
export function isTikTokPeakTime(now=Date.now()){
 const local=new Date(Number(now)+4*3600_000),day=local.getUTCDay(),hour=local.getUTCHours();
 return Number.isFinite(local.getTime())&&hour>=9&&(day>=1&&day<=5?hour>=15&&hour<20:hour>=14&&hour<21);
}
