import json
import os
import subprocess
from PIL import Image, ImageDraw, ImageFont

def load_devnet_log_sample():
    """Real devnet transaction data (assets/devnet-log-sample.json), fetched via
    getTransaction against https://api.devnet.solana.com, stage 9B/9D -- not a
    hardcoded/synthetic terminal simulation."""
    path = os.path.join(os.path.dirname(__file__), "..", "assets", "devnet-log-sample.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

WIDTH = 1920
HEIGHT = 1080

BG_COLOR = (5, 7, 10)
PANEL_COLOR = (13, 17, 23)
BORDER_COLOR = (33, 38, 45)
TEXT_WHITE = (240, 246, 252)
TEXT_MUTED = (139, 148, 158)
TEXT_DIM = (72, 79, 88)
AMBER = (255, 176, 0)
GREEN = (63, 185, 80)
RED = (248, 81, 73)
CYAN = (88, 166, 255)

def get_font(size, bold=False):
    # Try standard system fonts
    font_names = ["consola.ttf", "consolab.ttf"] if bold else ["consola.ttf"]
    for fn in font_names:
        try:
            return ImageFont.truetype(fn, size)
        except:
            pass
    try:
        font_path = "C:\\Windows\\Fonts\\segoeuib.ttf" if bold else "C:\\Windows\\Fonts\\segoeui.ttf"
        return ImageFont.truetype(font_path, size)
    except:
        return ImageFont.load_default()

def draw_header(draw, title_right="SOLANA DEVNET // CI TEST SUITE PASSING"):
    draw.rectangle([0, 0, WIDTH, 60], fill=PANEL_COLOR)
    draw.line([0, 60, WIDTH, 60], fill=BORDER_COLOR, width=2)
    
    # Dot
    draw.ellipse([40, 24, 52, 36], fill=AMBER)
    
    font_brand = get_font(20, bold=True)
    draw.text((65, 18), "WALLET_RADAR // WEEK 2 REPORT", fill=TEXT_WHITE, font=font_brand)
    
    font_meta = get_font(16)
    draw.text((WIDTH - 650, 20), title_right, fill=AMBER, font=font_meta)

def draw_footer(draw, text_subtitle):
    draw.rectangle([0, HEIGHT - 90, WIDTH, HEIGHT], fill=PANEL_COLOR)
    draw.line([0, HEIGHT - 90, WIDTH, HEIGHT - 90], fill=BORDER_COLOR, width=2)
    font_sub = get_font(18)
    draw.text((50, HEIGHT - 65), f"VOICEOVER: \"{text_subtitle}\"", fill=TEXT_WHITE, font=font_sub)

def render_slide_1(lang="ru"):
    img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
    draw = ImageDraw.Draw(img)
    draw_header(draw)
    
    # Eyebrow & Title
    f_eye = get_font(18, bold=True)
    f_tit = get_font(42, bold=True)
    f_desc = get_font(22)
    
    draw.text((80, 110), "01 // ARCHITECTURAL EVOLUTION", fill=AMBER, font=f_eye)
    draw.text((80, 145), "Autonomous Pre-Trade Firewall for Solana AI Agents", fill=TEXT_WHITE, font=f_tit)
    draw.text((80, 205), "Replaced static point-in-time checks with continuous behavioral baselines and active enforcement.", fill=TEXT_MUTED, font=f_desc)
    
    # 3 Pipeline Cards
    f_card_t = get_font(22, bold=True)
    f_card_d = get_font(16)
    
    cards = [
        ("AI AGENT LAYER", "Autonomous trading & copy agents\nGenerating transactions to execute", 80, False),
        ("PRE-TRADE FIREWALL GATE", "Wallet Radar continuous baseline\n9 behavioral rules · 0x1771 check", 700, True),
        ("SOLANA RUNTIME", "SPL Token-2022 Transfer Hook\nInstant execution or hard revert", 1320, False)
    ]
    
    for title, desc, x, is_accent in cards:
        b_col = AMBER if is_accent else BORDER_COLOR
        bg_col = (20, 24, 30) if is_accent else PANEL_COLOR
        draw.rounded_rectangle([x, 320, x + 520, 680], radius=16, fill=bg_col, outline=b_col, width=3 if is_accent else 2)
        
        t_col = AMBER if is_accent else TEXT_WHITE
        draw.text((x + 30, 360), title, fill=t_col, font=f_card_t)
        draw.text((x + 30, 420), desc, fill=TEXT_MUTED, font=f_card_d)
        
        if is_accent:
            draw.text((x + 30, 520), "[x] Zero LLM in critical decision path\n[x] Sub-millisecond local verdict\n[x] Bounded USD PnL & Venue tracking", fill=CYAN, font=f_card_d)
        elif x < 500:
            draw.text((x + 30, 520), "- ElizaOS / Solana Agent Kit\n- Automated copy-trade bots\n- Multi-venue liquidity callers", fill=TEXT_DIM, font=f_card_d)
        else:
            draw.text((x + 30, 520), "- Program: wvN1kyvjoFSJq...\n- Error code: 0x1771 (Block)\n- Rent-exempt state records", fill=TEXT_DIM, font=f_card_d)
            
    sub = "Вторая неделя: превратили прототип в боевой автономный пре-трейд фаервол для Solana AI-агентов..." if lang == "ru" else "Week two: evolved from prototype to an autonomous pre-trade firewall for Solana AI agents..."
    draw_footer(draw, sub)
    return img

def render_slide_2(lang="ru"):
    img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
    draw = ImageDraw.Draw(img)
    draw_header(draw)
    
    f_eye = get_font(18, bold=True)
    f_tit = get_font(42, bold=True)
    f_desc = get_font(22)
    
    log_sample = load_devnet_log_sample()

    draw.text((80, 110), "02 // ON-CHAIN ENFORCEMENT LAYER", fill=AMBER, font=f_eye)
    draw.text((80, 145), "SPL Token-2022 Transfer Hook Live on Solana Devnet", fill=TEXT_WHITE, font=f_tit)
    draw.text((80, 205), "Hardened across 11 internal audit revisions. Autonomous revert 0x1771 (CounterpartyFlagged).", fill=TEXT_MUTED, font=f_desc)

    # Terminal frame
    draw.rounded_rectangle([80, 280, 1840, 840], radius=16, fill=(0, 0, 0), outline=BORDER_COLOR, width=2)

    f_term = get_font(18)
    # Built from a real devnet transaction's actual logMessages (assets/devnet-log-sample.json,
    # stage 9B/9D) -- not a hand-typed simulation. Solana program logs carry no per-line
    # wall-clock timestamp, so none is invented here; only the real signature/slot/compute
    # units from that transaction's meta are shown.
    trace = [(f"$ solana confirm {log_sample['signature']} --url devnet", TEXT_WHITE)]
    for line in log_sample["logMessages"]:
        if "failed" in line or "REJECTED" in line or "CounterpartyFlagged" in line:
            col = RED
        elif "invoke" in line:
            col = CYAN
        else:
            col = TEXT_MUTED
        trace.append((f"  {line}", col))
    trace.append((
        f"RESULT: TRANSACTION REVERTED ON-CHAIN (slot {log_sample['slot']}, "
        f"{log_sample['computeUnitsConsumed']} compute units consumed) -- BALANCE TRANSFER BLOCKED",
        GREEN,
    ))

    y = 300
    for line, col in trace:
        draw.text((120, y), line, fill=col, font=f_term)
        y += 40
        
    sub = "Первое: ончейн-защита на SPL Token-2022 Transfer Hook развернута в Devnet. Пройдено 11 ревизий аудита..." if lang == "ru" else "First: on-chain defense via SPL Token-2022 Transfer Hook is live on Devnet across 11 audit revisions..."
    draw_footer(draw, sub)
    return img

def render_slide_3(lang="ru"):
    img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
    draw = ImageDraw.Draw(img)
    draw_header(draw)
    
    f_eye = get_font(18, bold=True)
    f_tit = get_font(42, bold=True)
    f_desc = get_font(22)
    
    draw.text((80, 110), "03 // DETERMINISTIC REASONING ENGINE", fill=AMBER, font=f_eye)
    draw.text((80, 145), "9 behavioral rules plus a funding-source check · Adaptive Burst Scaling", fill=TEXT_WHITE, font=f_tit)
    draw.text((80, 205), "Mathematical certainty instead of black-box probabilistic text generation.", fill=TEXT_MUTED, font=f_desc)
    
    # 3x3 Rules Grid
    f_r_t = get_font(20, bold=True)
    f_r_d = get_font(15)
    f_r_b = get_font(14, bold=True)
    
    rules = [
        ("01. OFF_HOURS", "Activity in UTC hours with 0 historical cadence", "NEW", AMBER),
        ("02. TOXIC_MINT", "Active freeze authority or supply concentration", "EXPLOIT", RED),
        ("03. REGIME_SHIFT", "Structural break across venue, pair or velocity", "BEHAVIOR", CYAN),
        ("04. ACTIVITY_BURST", "Scaled against medianTps to protect validators", "CALIBRATED", GREEN),
        ("05. DORMANT_ACTIVE", "Reactivation after N days of total silence", "ALERT", AMBER),
        ("06. WARMING", "Rapid high-value swaps on thin history (<5 tx)", "SYBIL", RED),
        ("07. LARGE_SWAP", "Outlier trade exceeding 3x bounded median USD", "SIZE", CYAN),
        ("08. CONCENTRATION", "Repeated aggressive routing into illiquid tokens", "RUG", RED),
        ("09. NEW_VENUE", "First-seen interaction with unverified DEX / AMM", "DISCOVERY", GREEN)
    ]
    
    for i, (title, desc, badge, bcol) in enumerate(rules):
        row = i // 3
        col = i % 3
        x = 80 + col * 590
        y = 280 + row * 180
        
        is_feat = (i == 0 or i == 3)
        bg = (22, 27, 34) if is_feat else PANEL_COLOR
        border = AMBER if is_feat else BORDER_COLOR
        
        draw.rounded_rectangle([x, y, x + 560, y + 160], radius=12, fill=bg, outline=border, width=2)
        draw.text((x + 25, y + 25), title, fill=TEXT_WHITE, font=f_r_t)
        draw.text((x + 420, y + 25), f"[{badge}]", fill=bcol, font=f_r_b)
        draw.text((x + 25, y + 75), desc, fill=TEXT_MUTED, font=f_r_d)
        draw.text((x + 25, y + 115), "Status: independent validation pending", fill=TEXT_DIM, font=get_font(13))
        
    sub = "Второе: девять поведенческих правил плюс проверка источника фондирования. Полностью исключили нейросети..." if lang == "ru" else "Second: nine behavioral rules plus a funding-source check. LLMs completely removed from decision path..."
    draw_footer(draw, sub)
    return img

def render_slide_4(lang="ru"):
    img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
    draw = ImageDraw.Draw(img)
    draw_header(draw)
    
    f_eye = get_font(18, bold=True)
    f_tit = get_font(42, bold=True)
    f_desc = get_font(22)
    
    draw.text((80, 110), "04 // EDGE DEPLOYMENT", fill=AMBER, font=f_eye)
    draw.text((80, 145), "Continuous Orange Pi Node · Independent Validation Pending", fill=TEXT_WHITE, font=f_tit)
    draw.text((80, 205), "Autonomous hardware node active. Walk-forward accuracy claim retracted pending ground-truth review (see ground-truth/PROTOCOL.md).", fill=TEXT_MUTED, font=f_desc)

    # 4 Stat Pillars
    f_num = get_font(56, bold=True)
    f_lbl = get_font(16, bold=True)
    f_sub = get_font(14)

    stats = [
        ("N/A", "WALK-FORWARD ACCURACY", "Retracted -- independent validation not yet complete", TEXT_MUTED),
        ("N/A", "FALSE BLOCKS ON DEX", "Retracted -- independent validation not yet complete", TEXT_MUTED),
        ("~150 MB", "EDGE NODE RAM FOOTPRINT (RSS, stage 9C measurement)", "Physical Orange Pi (ARM64, Armbian) daemon, continuous monitoring", AMBER),
        ("791", "PASSING UNIT TESTS", "5 documented known gaps (todo), 46 suites · CI regression suite", GREEN)
    ]

    for i, (val, lbl, subtext, col) in enumerate(stats):
        x = 80 + i * 445
        draw.rounded_rectangle([x, 280, x + 420, 600], radius=16, fill=PANEL_COLOR, outline=BORDER_COLOR, width=2)
        draw.text((x + 30, 320), val, fill=col, font=f_num)
        draw.text((x + 30, 420), lbl, fill=TEXT_WHITE, font=f_lbl)
        draw.text((x + 30, 460), subtext, fill=TEXT_MUTED, font=f_sub)
        draw.line([x + 30, 520, x + 390, 520], fill=BORDER_COLOR, width=1)
        draw.text((x + 30, 545), "SEE ground-truth/PROTOCOL.md", fill=TEXT_DIM, font=get_font(12, bold=True))
        
    # Bottom info box
    draw.rounded_rectangle([80, 640, 1840, 840], radius=16, fill=PANEL_COLOR, outline=BORDER_COLOR, width=2)
    draw.text((120, 675), "PHYSICAL NODE DEPLOYMENT (Orange Pi, ARM64/Armbian, @ 192.168.0.164)", fill=AMBER, font=get_font(20, bold=True))
    draw.text((120, 725), "• Services active: radar-http, radar-watch (daily alert mode), x402server, canary-agent", fill=TEXT_WHITE, font=get_font(16))
    draw.text((120, 765), "• Daily Telegram Digest scheduled at 07:00 UTC+3 with rich HTML summary and zero day-time spam", fill=TEXT_MUTED, font=get_font(16))
    
    sub = "Третье: независимая проверка точности History Machine ещё не завершена (см. ground-truth/PROTOCOL.md). Orange Pi (ARM64, Armbian), непрерывный мониторинг..." if lang == "ru" else "Third: independent accuracy validation of History Machine is not yet complete (see ground-truth/PROTOCOL.md). Orange Pi (ARM64, Armbian), continuous monitoring..."
    draw_footer(draw, sub)
    return img

def render_slide_5(lang="ru"):
    img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
    draw = ImageDraw.Draw(img)
    draw_header(draw)
    
    f_eye = get_font(18, bold=True)
    f_tit = get_font(42, bold=True)
    f_desc = get_font(22)
    
    draw.text((80, 110), "05 // ROADMAP & PRODUCTION MILESTONES", fill=AMBER, font=f_eye)
    draw.text((80, 145), "Next Steps: Bot SDK, Dialect Blinks & Scaled Watchlists", fill=TEXT_WHITE, font=f_tit)
    draw.text((80, 205), "Expanding developer adoption and agent ecosystem integration without expensive on-chain rent.", fill=TEXT_MUTED, font=f_desc)
    
    cards = [
        ("01", "COPY-TRADING BOT SDK", "One-line screening middleware for Jupiter and Raydium bots.\nIntercepts toxic counterparties before order submission.\nSupports Solana Agent Kit & ElizaOS plugins.", AMBER),
        ("02", "DIALECT BLINKS (ACTIONS)", "One-tap wallet safety scans directly in Twitter/X and Discord.\nx402 micropayments (0.005 USDC) with instant attestation.\nStandard Solana Actions manifest live at pay.cbellory.xyz.", CYAN),
        ("03", "SCALED WATCHLIST (100-300)", "Expanding continuous background monitoring on the Orange Pi node.\nAutomated harvester dataset across top institutional actors.\nContinuous anomaly telemetry without RPC overuse.", GREEN)
    ]
    
    for i, (num, title, desc, col) in enumerate(cards):
        x = 80 + i * 590
        draw.rounded_rectangle([x, 280, x + 560, 720], radius=16, fill=PANEL_COLOR, outline=BORDER_COLOR, width=2)
        draw.text((x + 35, 315), num, fill=col, font=get_font(48, bold=True))
        draw.text((x + 35, 400), title, fill=TEXT_WHITE, font=get_font(22, bold=True))
        draw.text((x + 35, 460), desc, fill=TEXT_MUTED, font=get_font(16))
        draw.line([x + 35, 620, x + 520, 620], fill=BORDER_COLOR, width=1)
        draw.text((x + 35, 650), "TARGET: PRODUCTION READY", fill=col, font=get_font(14, bold=True))
        
    # Tagline
    draw.text((WIDTH // 2 - 250, 780), "WALLET RADAR // HISTORY IS THE ONLY RECEIPT", fill=AMBER, font=get_font(20, bold=True))
    
    sub = "Что дальше: интеграция в боты копи-трейдинга через SDK, мгновенная проверка через Dialect Blinks..." if lang == "ru" else "Next steps: integrating into copy bots via SDK, one-tap checks via Dialect Blinks..."
    draw_footer(draw, sub)
    return img

def main():
    os.makedirs(os.path.join("docs", "slides"), exist_ok=True)
    os.makedirs(os.path.join("docs", "videos"), exist_ok=True)
    
    for lang in ["ru", "en"]:
        print(f"Rendering slides for [{lang}]...")
        s1 = render_slide_1(lang)
        s2 = render_slide_2(lang)
        s3 = render_slide_3(lang)
        s4 = render_slide_4(lang)
        s5 = render_slide_5(lang)
        
        s1.save(os.path.join("docs", "slides", f"slide-{lang}-1.png"))
        s2.save(os.path.join("docs", "slides", f"slide-{lang}-2.png"))
        s3.save(os.path.join("docs", "slides", f"slide-{lang}-3.png"))
        s4.save(os.path.join("docs", "slides", f"slide-{lang}-4.png"))
        s5.save(os.path.join("docs", "slides", f"slide-{lang}-5.png"))
        
        # Now compile with ffmpeg into an exact 60.00s video
        # Durations: S1 = 10s, S2 = 12s, S3 = 12s, S4 = 12s, S5 = 14s (Total: 60s)
        # Create an ffmpeg concat script
        concat_txt = os.path.join("docs", "slides", f"concat-{lang}.txt")
        with open(concat_txt, "w", encoding="utf-8") as f:
            f.write(f"file 'slide-{lang}-1.png'\nduration 10\n")
            f.write(f"file 'slide-{lang}-2.png'\nduration 12\n")
            f.write(f"file 'slide-{lang}-3.png'\nduration 12\n")
            f.write(f"file 'slide-{lang}-4.png'\nduration 12\n")
            f.write(f"file 'slide-{lang}-5.png'\nduration 14\n")
            # Repeat last file per ffmpeg concat spec
            f.write(f"file 'slide-{lang}-5.png'\n")
            
        audio_file = os.path.join("docs", "audio", f"weekly-voiceover-{lang}.mp3")
        video_out = os.path.join("docs", "videos", f"weekly-report-week2-{lang}.mp4")
        
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0", "-i", concat_txt,
            "-i", audio_file,
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
            "-c:a", "aac", "-b:a", "192k",
            "-t", "60.00",
            "-shortest",
            video_out
        ]
        print(f"Compiling video: {video_out}...")
        subprocess.run(cmd, check=True)
        print(f"==> Successfully generated {video_out}!")

if __name__ == "__main__":
    main()
