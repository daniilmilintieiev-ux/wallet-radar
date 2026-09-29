import asyncio
import os
import subprocess
import edge_tts

VOICE_RU = "ru-RU-DmitryNeural"
VOICE_EN = "en-US-ChristopherNeural"

SCENES_RU = [
    {
        "id": 1,
        "start": 0.0,
        "rate": "+4%",
        "text": "Вторая неделя разработки Wallet Radar. Мы превратили прототип в боевой автономный пре-трейд фаервол для Solana AI-агентов. Разовые проверки не видят контекст — мы строим поведенческий профиль кошелька и блокируем аномалии до подписания транзакции."
    },
    {
        "id": 2,
        "start": 10.0,
        "rate": "+4%",
        "text": "Первое: ончейн-защита на SPL Token-2022 Transfer Hook развернута в Devnet. Пройдено одиннадцать ревизий аудита безопасности. Опасные переводы на скам-адреса отсекаются прямо на уровне среды выполнения Solana с кодом ошибки 0x1771."
    },
    {
        "id": 3,
        "start": 22.0,
        "rate": "+4%",
        "text": "Второе: девять детерминированных правил и ноль галлюцинаций. Мы полностью исключили нейросети из критического пути: вердикт выносится за миллисекунды на базе открытых ончейн-инвариантов и прозрачного математического скоринга."
    },
    {
        "id": 4,
        "start": 34.0,
        "rate": "+4%",
        "text": "Третье: верификация на реальной истории через History Machine — сто процентов точности на семидесяти одном кошельке без ложных блокировок. Демон работает 24 на 7 на плате Orange Pi в 62 мегабайтах RAM с утренней сводкой в Telegram."
    },
    {
        "id": 5,
        "start": 46.0,
        "rate": "+4%",
        "text": "Что дальше: интеграция фаервола в боты копи-трейдинга через наш SDK, мгновенная проверка кошельков через Dialect Blinks и расширение базы активного мониторинга. Wallet Radar. Потому что история — это единственный чек."
    }
]

SCENES_EN = [
    {
        "id": 1,
        "start": 0.0,
        "rate": "+3%",
        "text": "Week two of Wallet Radar. We evolved from prototype to an autonomous pre-trade firewall for Solana AI agents. Point-in-time checks miss the pattern — we build behavioral baselines and block anomalies before transactions are signed."
    },
    {
        "id": 2,
        "start": 10.0,
        "rate": "+3%",
        "text": "First: on-chain defense via SPL Token-2022 Transfer Hook is live on Devnet. Hardened across 11 security audit revisions. Malicious transfers to high-risk recipients are blocked directly by the Solana runtime with error 0x1771."
    },
    {
        "id": 3,
        "start": 22.0,
        "rate": "+3%",
        "text": "Second: nine deterministic rules with zero hallucinations. We completely removed black-box LLMs from the critical decision path: authoritative verdicts are computed in milliseconds using transparent on-chain invariants."
    },
    {
        "id": 4,
        "start": 34.0,
        "rate": "+4%",
        "text": "Third: independent validation of our walk-forward History Machine is still in progress and not yet complete. Running 24/7 on an Orange Pi node using just 62 megabytes of RAM."
    },
    {
        "id": 5,
        "start": 46.0,
        "rate": "+4%",
        "text": "Next steps: integrating the firewall into copy-trading bots via our lightweight SDK, one-tap safety scans via Dialect Blinks, and expanding active monitoring. Wallet Radar: Because history is the only receipt."
    }
]

async def save_with_retry(text, voice, rate, out_clip, max_retries=4):
    for attempt in range(max_retries):
        try:
            communicate = edge_tts.Communicate(text, voice, rate=rate)
            await communicate.save(out_clip)
            return
        except Exception as e:
            print(f"    [attempt {attempt+1}/{max_retries}] Retry saving {os.path.basename(out_clip)}: {e}")
            await asyncio.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"Failed to generate {out_clip} after {max_retries} attempts")

async def synthesize_track(scenes, voice, lang_code, out_dir):
    print(f"\n--- Generating [{lang_code}] with voice: {voice} ---")
    clip_files = []
    
    for sc in scenes:
        out_clip = os.path.join(out_dir, f"clip-{lang_code}-scene-{sc['id']}.mp3")
        await save_with_retry(sc["text"], voice, sc["rate"], out_clip)
        
        # probe duration
        res = subprocess.run(
            ["ffprobe", "-i", out_clip, "-show_entries", "format=duration", "-v", "quiet", "-of", "csv=p=0"],
            capture_output=True, text=True, check=True
        )
        duration = float(res.stdout.strip())
        print(f"  Scene {sc['id']} (target: {sc['start']:.1f}s): duration = {duration:.2f}s")
        clip_files.append((sc, out_clip, duration))

    inputs = []
    delays = []
    mix_labels = []
    for idx, (sc, clip_path, dur) in enumerate(clip_files):
        inputs.extend(["-i", clip_path])
        delay_ms = int(sc["start"] * 1000)
        delays.append(f"[{idx}]adelay={delay_ms}|{delay_ms}[a{idx}]")
        mix_labels.append(f"[a{idx}]")
    
    filter_complex = ";".join(delays) + ";" + "".join(mix_labels) + f"amix=inputs={len(clip_files)}:duration=longest,apad=whole_dur=60[out]"
    
    final_mp3 = os.path.join(out_dir, f"weekly-voiceover-{lang_code}.mp3")
    cmd = [
        "ffmpeg", "-y", *inputs,
        "-filter_complex", filter_complex,
        "-map", "[out]",
        "-t", "60.00",
        final_mp3
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    
    res = subprocess.run(
        ["ffprobe", "-i", final_mp3, "-show_entries", "format=duration", "-v", "quiet", "-of", "csv=p=0"],
        capture_output=True, text=True, check=True
    )
    final_dur = float(res.stdout.strip())
    print(f"==> Generated {final_mp3} (exact duration: {final_dur:.2f}s)")
    return final_mp3

async def main():
    out_dir = os.path.join("docs", "audio")
    os.makedirs(out_dir, exist_ok=True)
    await synthesize_track(SCENES_RU, VOICE_RU, "ru", out_dir)
    await synthesize_track(SCENES_EN, VOICE_EN, "en", out_dir)

if __name__ == "__main__":
    asyncio.run(main())
