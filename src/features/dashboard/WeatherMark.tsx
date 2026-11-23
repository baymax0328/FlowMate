import { useEffect, useState } from 'react';

type Weather = { code: number; temperature: number; day: boolean; at: number };
export function WeatherMark() {
  const [weather, setWeather] = useState<Weather | null>(null);
  useEffect(() => {
    let alive = true;
    let controller: AbortController | null = null;
    async function load() {
      try {
        const cached = JSON.parse(localStorage.getItem('fm.weather.guangzhou') ?? 'null') as Weather | null;
        if (cached && Date.now() - cached.at < 30 * 60 * 1000) { if (alive) setWeather(cached); return; }
        const requestController = new AbortController();
        controller = requestController;
        const timeout = window.setTimeout(() => requestController.abort(), 10000);
        let response: Response;
        try { response = await fetch('https://api.open-meteo.com/v1/forecast?latitude=23.1291&longitude=113.2644&current=temperature_2m,weather_code,is_day&timezone=Asia%2FShanghai', { signal: requestController.signal }); }
        finally { window.clearTimeout(timeout); }
        if (!response.ok) throw new Error('Weather unavailable');
        const { current } = await response.json();
        if (!Number.isFinite(current?.weather_code) || !Number.isFinite(current?.temperature_2m)) throw new Error('Invalid weather');
        const next = { code: current.weather_code, temperature: current.temperature_2m, day: current.is_day === 1, at: Date.now() };
        if (alive) { setWeather(next); try { localStorage.setItem('fm.weather.guangzhou', JSON.stringify(next)); } catch { /* 隐私模式下写不了本地缓存，忽略即可。 */ } }
      } catch { if (alive) setWeather(null); }
    }
    void load(); const timer = window.setInterval(() => void load(), 30 * 60 * 1000);
    return () => { alive = false; controller?.abort(); window.clearInterval(timer); };
  }, []);
  const c = weather?.code;
  const kind = c == null ? 'unknown' : c >= 95 ? 'storm' : c >= 71 && c <= 77 || c >= 85 && c <= 86 ? 'snow' : c >= 51 ? 'rain' : c >= 45 ? 'fog' : c >= 2 ? 'cloud' : 'sun';
  const names = { unknown: '天气暂不可用', storm: '雷雨', snow: '降雪', rain: '降雨', fog: '有雾', cloud: '多云', sun: weather?.day ? '晴天' : '晴夜' };
  const label = `广东广州 · ${names[kind]}${weather ? ` · ${Math.round(weather.temperature)}℃ · Open-Meteo` : ''}`;
  return <span className={`greeting-weather weather-${kind}`} role="img" aria-label={label} title={label} data-weather={kind}>
    <svg viewBox="0 0 64 64" width="46" height="46" aria-hidden="true">
      <defs><linearGradient id="weather-cloud" x2="0" y2="1"><stop stopColor="#fdfefe"/><stop offset="1" stopColor="#c2d7e1"/></linearGradient><linearGradient id="weather-sun" x2="0" y2="1"><stop stopColor="#ffdc79"/><stop offset="1" stopColor="#f2ac42"/></linearGradient></defs>
      {kind === 'sun' && !weather?.day ? <path d="M42 8a22 22 0 1 0 13 35A23 23 0 0 1 42 8" fill="#d5d9f1" /> : kind === 'sun' || kind === 'cloud' ? <g stroke="#efbe59" strokeWidth="3" strokeLinecap="round"><path d="M26 5v4M26 43v4M5 26h4M43 26h4M11 11l3 3M38 38l3 3M11 41l3-3M38 14l3-3"/><circle cx="26" cy="26" r="13" fill="url(#weather-sun)" stroke="none"/></g> : null}
      {kind !== 'sun' ? <path d="M16 44a10 10 0 0 1-1-20 15 15 0 0 1 28-2 11 11 0 1 1 5 22z" fill="url(#weather-cloud)" stroke="#b6ccd6" strokeWidth="1"/> : null}
      {kind === 'rain' ? <g stroke="#6eabd6" strokeWidth="3" strokeLinecap="round"><path d="m22 49-3 6m15-6-3 6m15-6-3 6"/></g> : null}
      {kind === 'storm' ? <path d="m33 39-8 12h7l-3 11 13-16h-8l4-7z" fill="#e7b94c"/> : null}
      {kind === 'snow' ? <g fill="#8bbed9"><circle cx="20" cy="53" r="2"/><circle cx="33" cy="55" r="2"/><circle cx="46" cy="53" r="2"/></g> : null}
      {kind === 'fog' ? <path d="M14 50h36M18 56h28" stroke="#b1c3ce" strokeWidth="3" strokeLinecap="round"/> : null}
    </svg>
  </span>;
}
