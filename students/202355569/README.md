# BONK GARDEN — 3D 두더지 잡기

학번: **202355569** · 지능형 IoT 플랫폼 컨테이너 과제

## 1. 컨테이너 소개
3D 정원에서 뿅망치로 두더지를 잡는 웹 게임 서비스입니다. 랭킹과 방명록으로 다른 사람의 기록과 한마디를 함께 볼 수 있습니다.

- Three.js로 직접 만든 3D 정원: 하늘·언덕·나무·버섯·꽃·구름·나비, 툰 셰이딩과 그림자
- 두더지(+10), 황금 두더지(+30, 짧게 나옴), 토끼(때리면 −20, 콤보 초기화)
- 쉬움·보통·어려움 3단계: 구멍 6 → 9 → 12개, 단계가 오를수록 더 자주 나오고 더 빨리 숨음
- 게임 중에는 마우스 커서가 뿅망치로 바뀌고, 맞히면 별·반짝이·파문과 효과음
- 60초, 점수·콤보·정확도(잡은 수/클릭 수)·평균 반응 속도, 일시정지(Esc)와 탭 비활성화 시 자동 일시정지
- 시작 화면에서 두더지·황금 두더지·토끼를 3D 모델 그대로 렌더링한 그림으로 소개
- 가운데 게임 창 양옆에 랭킹(1~3위는 시상대)과 쪽지 모양 방명록, 상단에 누적 플레이 수
- 점수 100점마다 응원단 토끼가 한 마리씩(최대 12마리) 구멍 뒤에 나타나 폼폼을 흔들며 응원
- 게임이 끝나면 닉네임으로 랭킹 등록, 방명록은 오른쪽 패널 아래 입력 폼에서 언제든 작성

공식 서비스가 아닌 학습용 팬 프로젝트입니다.

## 2. 아키텍처
```mermaid
flowchart LR
  U[사용자 브라우저] --> R[HTTPS Route]
  R --> S[Service :8080]
  S --> P[Pod: Python HTTP 서버]
  D[Deployment: replicas 1] --> P
  C[ConfigMap: 앱 코드 / three.js / 이미지·소리] --> P
  P --> V[PVC /data: SQLite]
```

| 구성 | 역할 |
|---|---|
| Deployment | Python 서버 Pod 1개 관리, Recreate 업데이트 |
| Service | app=typing-garden Pod의 http 포트에 연결 |
| Route | edge TLS 종료, HTTP 요청을 HTTPS로 전환 |
| ConfigMap | typing-garden-app(코드), typing-garden-three(gzip three.js), typing-garden-media(효과음 등 미디어, 용량에 따라 -2, -3…으로 나뉨)를 projected 볼륨으로 /app에 함께 읽기 전용 마운트 |
| PVC | 1Gi ReadWriteOnce, /data/garden.db에 랭킹·방명록 저장 |
| Startup/Liveness/Readiness Probe | 기동·생존·DB 연결 상태 검사 |

SQLite 동시 파일 접근과 RWO 볼륨 연결을 단순하게 유지하기 위해 replicas=1 및 Recreate를 사용합니다. 업데이트 중 짧은 접속 중단이 있습니다. 자원 요청은 CPU 50m/메모리 96Mi, 제한은 CPU 500m/메모리 256Mi입니다. Pod는 비루트 임의 UID로 실행되며 권한 상승을 허용하지 않습니다.

## 3. 사용 이미지
- 이미지: `registry.access.redhat.com/ubi9/python-312@sha256:2c7a89f9f1e69f2a00036041ef744b45c8830bebcb2f7194f403ca93729bb0cc`
- 이유: 공개 UBI Python 런타임으로 OpenShift 임의 UID 실행에 맞추기 쉽습니다.
- 포트: `8080`, 프로세스: `python3 /app/server.py`
- 추가 패키지 설치·이미지 빌드 없이 Python 표준 라이브러리 HTTP 서버와 SQLite를 사용합니다.
- 실행 검증한 이미지 digest를 고정했습니다.

## 4. 배포 방법
본인 Sandbox에 로그인한 뒤 본인 프로젝트를 선택합니다. 토큰은 Git에 저장하지 않습니다.

저장소 최상위에서:
```bash
oc apply -f students/202355569/k8s/
oc rollout status deployment/typing-garden
oc get pods
oc get route typing-garden
```
학번 폴더 안에서는 `oc apply -f k8s/`를 사용합니다. 배포 YAML에는 namespace와 Route host를 고정하지 않았습니다.

배포 후 확인:
- 브라우저: `oc get route typing-garden`의 HOST에 https://를 붙여 접속하면 가운데 3D 두더지 게임 창, 왼쪽 랭킹(시상대), 오른쪽 방명록이 있는 BONK GARDEN 시작 화면이 열립니다.
- curl: `curl https://<HOST>/api/ready` → `{"ready": true}` (DB 연결까지 확인), `curl https://<HOST>/api/leaderboard?difficulty=normal` → `{"items": [...]}`

설정 변경: deployment.yaml의 GAME_DURATION(초)을 수정합니다. 화면 안내는 기본값 60초에 맞춰져 있으므로 변경 시 문구도 함께 수정합니다.
코드 변경: `src/`의 파일을 수정하고 `python3 build.py`로 `k8s/configmap*.yaml`을 다시 만든 뒤 적용하고 `oc rollout restart deployment/typing-garden`을 실행합니다. 배포에는 YAML만 필요하며 이미지 빌드는 없습니다.
`oc apply`는 객체 전체를 256KB 제한이 있는 annotation에 저장하므로, build.py는 코드·three.js·미디어를 ConfigMap으로 나누고 미디어는 250KB 단위로 자동 분할하며 deployment.yaml의 projected 볼륨 목록도 함께 갱신합니다. three.js는 gzip으로 저장하고 서버가 `Content-Encoding: gzip`으로 그대로 보냅니다.
효과음: 뿅망치·두더지 소리는 Web Audio로 합성하고, 버튼 클릭음은 `src/assets/keyboard.mp3`를 사용합니다.

## 5. 배포 결과 및 검증
- 본인 프로젝트 wint123-dev에 배포, Deployment 롤아웃 성공 확인
- 공개 HTTPS Route에서 `/api/ready`가 `{"ready": true}` 응답
- 로컬 API 테스트: 난이도별 구멍 수(6/9/12)와 출현 계획 생성, 서버 점수 재계산이 화면 점수와 일치, 랭킹·방명록 동시 등록/조회, 기존 DB 컬럼 자동 추가
- 브라우저(데스크톱·모바일 크기): 시작 화면, 난이도 전환, 게임 진행·뿅망치 커서·타격 효과, 일시정지, 결과·등록 화면 확인
- Pod 재시작(`oc rollout restart`) 후에도 PVC의 랭킹·방명록 유지 확인

배포 주소: https://typing-garden-wint123-dev.apps.rm3.7wse.p1.openshiftapps.com

![게임 화면](images/game.png)

`oc get` 출력: [deployment-status.txt](images/deployment-status.txt)

초기화 재배포 검증은 테스트 데이터만 있는 상태에서 진행합니다. 아래 명령은 PVC까지 삭제하므로 기존 기록이 사라질 수 있습니다.
```bash
oc delete -f k8s/
oc apply -f k8s/
oc rollout status deployment/typing-garden
```

## 6. 어려웠던 점
- **ConfigMap이 `oc apply`에서 거부됨**: three.js(약 670KB)를 ConfigMap에 넣자 `metadata.annotations: Too long` 오류가 났습니다. `oc apply`가 객체 전체를 256KB 제한의 last-applied annotation에 저장하기 때문이었습니다. three.js를 gzip(약 166KB)으로 저장해 서버가 `Content-Encoding: gzip`으로 보내게 하고, 코드·three.js·미디어를 ConfigMap 3개로 나눠 projected 볼륨 하나로 /app에 합쳤습니다. 이 분할은 build.py가 자동으로 합니다.
- **코드를 바꿔도 화면이 그대로임**: ConfigMap만 바뀌고 Deployment는 그대로라 `oc apply` 결과가 `unchanged`였고, 이미 실행 중인 Python 서버가 옛 파일을 계속 제공했습니다. 적용 후 `oc rollout restart deployment/typing-garden`으로 Pod를 새로 띄워 해결했습니다.
- **기존 DB와 새 버전의 스키마 차이**: 기능을 바꾸며 테이블에 컬럼이 늘었는데 PVC의 기존 DB에는 없었습니다. 서버 시작 시 `PRAGMA table_info`로 확인해 없는 컬럼만 `ALTER TABLE`로 추가하도록 했습니다.
- **효과음 파일 다운로드 차단**: Pixabay가 스크립트 다운로드를 막아(403) 직접 받은 mp3를 앞뒤 무음을 잘라 넣고, 게임 효과음은 Web Audio로 합성했습니다.
- **점수 조작 방지**: 브라우저가 보낸 점수를 그대로 믿지 않도록 서버가 출현 계획을 미리 만들고, 타격 기록만 받아 점수를 다시 계산합니다.

## 7. AI·참고자료 활용 내역
- Codex: 과제 요구사항 분석, SVG/CSS 디자인, 게임·API·YAML·README 초안 작성과 실행 검증 지원
- Claude Code: Three.js 3D 두더지 잡기 게임·정원 제작, 서버 출현 계획·점수 검증, 랭킹·방명록 패널과 통합 등록, ConfigMap 자동 분할 build.py 작성
- three.js r160 (MIT): https://threejs.org
- 버튼 클릭음: Pixabay "spacebar click keyboard" https://pixabay.com/sound-effects/film-special-effects-spacebar-click-keyboard-199448/
- 3D 정원·동물: three.js 기본 도형으로 직접 모델링
- 제공된 과제 안내: 나만의 컨테이너 만들기, 3~10쪽
- 제공된 강의자료: 실제 운영 환경 고려사항, OpenShift 실습(2), 핸즈온 워크샵 매뉴얼
- https://kubernetes.io/docs/concepts/configuration/configmap/
- https://kubernetes.io/docs/concepts/storage/persistent-volumes/
- https://docs.python.org/3/library/sqlite3.html
- https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay

제출 전 실제 실행 결과를 직접 확인하고, YAML 각 항목의 역할을 설명할 수 있도록 검토합니다.

## 부록. 구현 기준과 한계
- 3D 화면은 WebGL이 필요합니다. 지원하지 않는 브라우저에서는 안내 문구를 보여줍니다.
- 출현 계획: 게임 시작 시 서버가 60초 동안의 출현(시간·구멍·머무는 시간·종류)을 미리 만들고, 같은 구멍은 이전 동물이 들어간 뒤에만 다시 씁니다.
- 난이도: 쉬움 구멍 6·간격 약 0.95초·머무름 1.35초, 보통 9·0.72초·1.05초, 어려움 12·0.5초·0.78초. 황금 두더지는 머무는 시간이 25% 짧습니다.
- 점수: 두더지 10·황금 30에 난이도 계수(1/1.3/1.6)를 곱하고 min(콤보,20)×2 추가. 토끼는 −20×계수, 콤보 초기화. 두더지를 놓치면 콤보가 끊깁니다. 최종 점수는 0 미만이 되지 않습니다.
- 정확도: 잡은 두더지 수 / 클릭 수 ×100. 반응 속도: 두더지가 나온 뒤 맞힐 때까지의 평균(ms).
- 서버는 세션·시간·출현 시간 안의 타격인지·중복 타격을 확인하고 기록으로 점수를 재계산합니다. 클릭 수와 타격 기록은 클라이언트 값을 신뢰하므로 전문적인 부정행위 방지 시스템은 아닙니다.
- 랭킹은 난이도별 상위 30개, 방명록은 최근 60개를 보여줍니다. 랭킹은 게임 한 판(세션)당 한 번, 잡은 두더지가 있을 때만 등록할 수 있습니다. 방명록은 같은 IP에서 10초에 한 번 남길 수 있습니다.
- 닉네임 1~12자, 방명록 1~140자. SQL 매개변수 처리, 화면 textContent 렌더링, 요청 크기 제한을 적용합니다.
- 난이도·소리·닉네임은 현재 브라우저에만 남습니다.
- 학습용 소규모 서버입니다. 회원 인증·대규모 트래픽 처리는 포함하지 않습니다.
