# PacketLabManager

**이더넷 패킷 생성 · 캡처 · 시나리오 검증 통합 플랫폼 (Linux / Node.js)**

> Ethernet Packet Generation, Capture & Scenario Validation Platform

---

## 개요 (Overview)

PacketLabManager는 이더넷 네트워크 테스트를 위한 풀스택 랩 도구입니다.  
**Linux + Node.js 단독**으로 모든 기능이 동작합니다.

### 주요 기능

- UDP / TCP / ICMP / ARP / 커스텀 이더넷 패킷 전송 (VLAN 지원)
- libpcap / tcpdump 기반 실시간 패킷 캡처 + 헥스·프로토콜 디코드
- **2-PC 멀티 노드 테스트** — Node A ↔ Node B 포워딩 검증, PASS/FAIL 매트릭스 리포트
- **캡처 탭에서 Node B 인터페이스 직접 선택** (원격 캡처 + 로컬 병합)
- HyperTerminal: 시리얼 콘솔, PHY 레지스터 R/W, FDB 테이블, 자동화 시퀀스
- Port Mapping: 6포트 스위치 ↔ Node A / Node B 인터페이스 매핑 관리
- 테스트 케이스 관리 및 매크로 시퀀서

---

## 아키텍처 (Architecture)

```
┌─────────────────────────────────────────────────────────┐
│  Browser  http://localhost:8080                         │
│  Vanilla JS Web UI  ◄──── WebSocket ───►                │
└──────────────────────────┬──────────────────────────────┘
                           │  REST / WebSocket
┌──────────────────────────▼──────────────────────────────┐
│  PacketLabManager Server  (Node.js  :8080)              │
│  Express REST API  +  WorkerHub                         │
│                                                         │
│  services/                                              │
│    frameBuilder.js   — 순수 JS 이더넷 프레임 빌더       │
│    packetBackend.js  — cap npm + tcpdump fallback       │
│    serialBridge.js   — serialport npm 시리얼 관리자     │
│    switchProtocol.js — 레지스터/FDB 텍스트 프로토콜     │
│    autoEngine.js     — JS 자동화 테스트 러너            │
└─────────────────────────────────────────────────────────┘

2-PC 구성 (스위치 포워딩 테스트):

  Node A (169.254.88.222:8080)       Node B (169.254.1.168:8080)
  enp12s0f0 (P0) ─┐             ┌─ enp3s0f1 (P4)
  enp12s0f1 (P1) ─┤             ├─ enp3s0f0 (P5)
  enp12s0f2 (P2) ─┤ L2 Switch   │
  enp12s0f3 (P3) ─┘ (P0~P5)    ─┘
```

---

## 사전 요구사항 (Prerequisites)

### Ubuntu / Debian

```bash
sudo apt install -y git nodejs npm tcpdump libpcap-dev build-essential
```

| 기능 | 필요 패키지 |
|------|------------|
| 시리얼·레지스터·FDB·자동화 | `nodejs npm` |
| 패킷 캡처 (tcpdump) | `+ tcpdump` |
| 패킷 전송 + 캡처 (libpcap) | `+ libpcap-dev build-essential` |

### Windows (Npcap)

Windows에서도 패킷 송신/캡처가 동작합니다 (`cap` npm + Npcap). `cap`은 Windows용
prebuilt 바이너리를 제공하지 않으므로 **현재 머신에서 한 번 빌드**해야 합니다.

사전 설치 (1회):

1. **Npcap** 런타임 — https://npcap.com/#download (설치 시 *"WinPcap API-compatible Mode"* 권장)
2. **Visual Studio Build Tools** — "Desktop development with C++" 워크로드
3. **Python 3** — https://www.python.org/ (node-gyp 의존성)

빌드:

```powershell
cd server
npm install
npm run setup:windows-cap   # Npcap SDK 자동 다운로드 + cap.node 재빌드
node server.js
```

`setup:windows-cap`은 Npcap SDK를 받아 `node_modules/cap/deps/winpcap`에 배치하고
`cap.node`를 현재 Node/아키텍처에 맞게 다시 빌드합니다. 성공 시
`[PacketLabManager] Packets : cap npm ready (send+capture)` 가 출력됩니다.

> 참고: `node_modules`에 커밋된 `cap.node`는 빌드된 OS 전용입니다. **다른 OS로 옮기면
> `npm rebuild cap`(Linux/macOS) 또는 `npm run setup:windows-cap`(Windows)으로 재빌드**하세요.

---

## 설치 및 실행 (Quick Start)

```bash
# 1. 클론
git clone https://github.com/hwkim3330/20260602.git
cd 20260602/server

# 2. 패키지 설치
npm install

# 3. 실행 (캡처·전송은 root 권한 필요)
sudo node server.js
```

브라우저: `http://localhost:8080`

### 두 PC 동시 실행 (2-PC 테스트)

두 PC 모두 동일한 코드로 실행합니다:

```bash
# Node A (예: 169.254.88.222)
sudo node server.js

# Node B (예: 169.254.1.168) — 같은 코드 복사 후
sudo node server.js
```

Settings 탭 → Port Mapping에서 Node B URL 및 포트-인터페이스 매핑 설정 후 저장.

---

## 웹 UI 탭 안내

| 탭 | 설명 |
|----|------|
| **Packet Generator** | UDP·TCP·ICMP·ARP·Raw 이더넷 패킷 빌드 및 전송 |
| **Capture** | 실시간 패킷 캡처 — Node A·B 인터페이스 동시 선택 가능 |
| **Scenario Lab** | 멀티 노드 A↔B 포워딩 시나리오 테스트 |
| **HyperTerminal** | 시리얼 콘솔·레지스터·FDB·자동화 통합 터미널 |
| **Settings** | Port Mapping, 2-PC 실험, Matrix 테스트 |

---

## API 요약

Base URL: `http://localhost:8080/api`

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/interfaces` | 네트워크 인터페이스 목록 |
| POST | `/build` | 패킷 프레임 빌드 (hex 반환) |
| POST | `/send` | 패킷 전송 |
| GET | `/capture/status` | 캡처 상태 + 인터페이스 목록 |
| POST | `/capture/start` | 캡처 시작 (`interfaces`, `bpfFilter`) |
| POST | `/capture/stop` | 캡처 중지 |
| GET | `/capture/packets` | 캡처된 패킷 목록 (`?limit=&offset=`) |
| POST | `/capture/clear` | 캡처 버퍼 초기화 |
| POST | `/simple-bidir-forward-test` | 2-PC 양방향 포워딩 테스트 |
| GET | `/portmap` | 포트 매핑 조회 |
| POST | `/portmap` | 포트 매핑 저장 |
| GET | `/tty/list` | 시리얼 포트 목록 |
| GET | `/serial/status` | 시리얼 연결 상태 |
| POST | `/serial/connect` | 시리얼 포트 연결 (`port`, `baudRate`, ...) |
| POST | `/serial/disconnect` | 시리얼 포트 해제 |
| POST | `/serial/send` | 데이터 전송 (`hex` 또는 `text`) |
| GET | `/register/status` | 레지스터 세션 상태 |
| POST | `/register/read` | 레지스터 읽기 (`offset`) |
| POST | `/register/write` | 레지스터 쓰기 (`offset`, `value`) |
| POST | `/register/base-addr` | 기준 주소 설정 |
| POST | `/fdb/read` | FDB 엔트리 조회 (`mac`, `vlanId`) |
| POST | `/fdb/write` | FDB 엔트리 등록 |
| POST | `/fdb/delete` | FDB 엔트리 삭제 |
| POST | `/fdb/flush` | FDB 전체 초기화 |
| POST | `/mdio/read` | PHY 레지스터 읽기 (`port`, `phyAddr`, `regAddr`) |
| POST | `/mdio/write` | PHY 레지스터 쓰기 |
| GET | `/mdio/link-status` | 6포트 링크 상태 (시리얼 필요) |
| GET | `/counter/read` | 포트 카운터 읽기 (`?port=all\|0-5`, 시리얼 필요) |
| GET | `/timestamp/read` | 타임스탬프 레지스터 읽기 |
| GET | `/backend/status` | 서버·패킷·시리얼 상태 요약 |
| GET | `/health` | 서버 헬스 체크 |

---

## 프로젝트 구조

```
20260602/
├── server/                         # Node.js 서버 (메인)
│   ├── server.js                   # 진입점
│   ├── package.json
│   ├── routes/                     # REST 라우트
│   │   ├── capture.js
│   │   ├── packet.js
│   │   ├── portmap.js
│   │   ├── tty.js / serial.js
│   │   ├── register.js / fdb.js / mdio.js
│   │   └── ...
│   ├── services/
│   │   ├── frameBuilder.js         # 이더넷 프레임 빌더
│   │   ├── packetBackend.js        # cap + tcpdump 캡처/전송
│   │   ├── serialBridge.js         # 시리얼 관리
│   │   ├── switchProtocol.js       # 레지스터/FDB 프로토콜
│   │   └── autoEngine.js           # 자동화 엔진
│   └── public/                     # 웹 UI
│       ├── index.html
│       ├── app.js
│       └── styles.css
├── docs/
└── README.md
```

---

## 라이선스

MIT License — © 2026 KETI (Korea Electronics Technology Institute)
