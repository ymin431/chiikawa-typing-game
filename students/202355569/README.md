# TYPEFALL — 먼작귀 타이핑

학번: **202355569** · 지능형 IoT 플랫폼 컨테이너 과제

## 1. 컨테이너 소개
먼작귀(치이카와 친구들)가 하늘에서 내려오는 3D 산성비 타자게임 웹 서비스입니다. 좋아하는 캐릭터와 타건음을 통해 즐겁게 꾸준히 타자를 연습하고 싶어 이 주제를 선택했습니다.

- Three.js로 그린 전체 화면 장면: 잔디밭 그림 위로 구름 그림자가 흐르고, 마우스를 따라 시점이 움직이는 깊이감 있는 배경
- 치이카와·하치와레·우사기·랏코·모몽가·쿠리만쥬·시사·카니가 단어를 달고 떨어지고, 맞히면 반짝이·파문, 놓치면 잔디 위 먼지가 생깁니다.
- 60초, 하트 5개, 쉬움·보통·어려움, 한글·영어
- 점수·콤보·정확도·타/분, 일시정지(Esc)와 탭 비활성화 시 자동 일시정지
- 키보드 타건음(keyboard.mp3)과 Web Audio로 합성한 정답 차임
- 왼쪽 패널에서 난이도·언어별 랭킹과 방명록 확인
- 게임이 끝나면 한 화면에서 프로필 캐릭터를 고르고 랭킹·방명록을 함께 등록

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
| ConfigMap | typing-garden-app(코드), typing-garden-three(gzip three.js), typing-garden-media(배경·타건음·캐릭터 이미지, 용량에 따라 -2, -3…으로 나뉨)를 projected 볼륨으로 /app에 함께 읽기 전용 마운트 |
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
학번 폴더 안에서는 `oc apply -f k8s/`를 사용합니다. Route의 HOST 주소에 https://를 붙이면 시작 화면이 열립니다. 배포 YAML에는 namespace와 Route host를 고정하지 않았습니다.

설정 변경: deployment.yaml의 GAME_DURATION(초), GAME_LIVES(하트)를 수정합니다. 현재 화면 안내는 기본값 60초/5개에 맞춰져 있으므로 변경 시 ConfigMap의 문구도 함께 수정합니다.
코드 변경: `src/`의 파일을 수정하고 `python3 build.py`로 `k8s/configmap*.yaml`을 다시 만든 뒤 적용하고 `oc rollout restart deployment/typing-garden`을 실행합니다. 배포에는 YAML만 필요하며 이미지 빌드는 없습니다.
`oc apply`는 객체 전체를 256KB 제한이 있는 annotation에 저장하므로, build.py는 코드·three.js·미디어를 ConfigMap으로 나누고 미디어는 250KB 단위로 자동 분할하며 deployment.yaml의 projected 볼륨 목록도 함께 갱신합니다. three.js는 gzip으로 저장하고 서버가 `Content-Encoding: gzip`으로 그대로 보냅니다.
캐릭터 이미지: `src/assets/`의 `fall-<캐릭터>-<번호>.png`(떨어지는 그림)와 `profile-<캐릭터>.png`(프로필)를 같은 이름의 실제 이미지로 바꾸고 build.py를 실행합니다. 캐릭터 이름은 chiikawa, hachiware, usagi, rakko, momonga, kurimanju, shisa, kani입니다. 서버가 파일 이름으로 이미지를 찾으므로 번호는 2개든 3개든 상관없고, png·webp·jpg를 쓸 수 있습니다. 이미지 한 장은 약 180KB 이하여야 합니다.
타건음: `src/assets/keyboard.mp3`. 파일이 없으면 합성한 타건음을 사용합니다.

## 5. 배포 결과 및 검증
- 본인 프로젝트 wint123-dev에 배포, Deployment 롤아웃 성공 확인
- 공개 HTTPS Route에서 `/api/ready`가 `{"ready": true}` 응답
- 로컬 API 테스트: 정답 점수, 놓친 단어, 게임 종료, 랭킹·방명록 동시 등록/조회, 기존 DB 컬럼 자동 추가 통과
- 브라우저: 초기 화면, 연습 시작, 결과 화면 확인
- 제출 YAML 전체 삭제 후 재적용 및 롤아웃 성공 확인
- Pod 재시작 전 세션을 재시작 후 완료: PVC 유지 검증 통과
- 브라우저 영문 정답, 100% 정확도, 일시정지·재개·결과 화면 검증
- 실제 한글 IME 조합 입력은 사용자 환경에서 추가 확인 필요

배포 주소: https://typing-garden-wint123-dev.apps.rm3.7wse.p1.openshiftapps.com

![게임 화면](images/game.png)

실제 리소스 상태: [deployment-status.txt](images/deployment-status.txt)

초기화 재배포 검증은 테스트 데이터만 있는 상태에서 진행합니다. 아래 명령은 PVC까지 삭제하므로 기존 기록이 사라질 수 있습니다.
```bash
oc delete -f k8s/
oc apply -f k8s/
oc rollout status deployment/typing-garden
```

## 6. 구현 기준과 한계
- 3D 화면은 WebGL이 필요합니다. 지원하지 않는 브라우저에서는 안내 문구를 보여줍니다.
- 정확도: 제출 문자열과 목표 문자열의 편집거리 기준. 각 제출의 max(목표 길이,입력 길이)에서 편집거리를 뺀 값의 합 / 비교 길이 합 ×100. Enter 전에 수정한 오타·놓친 단어는 제외합니다.
- 속도: 완성한 정답 글자 수 / 일시정지를 제외한 플레이 시간(분). 한글 한 음절을 한 글자로 셉니다. 물리적 키 입력 타수와 다릅니다.
- 점수: 단어 글자 수×10×난이도 계수(1/1.3/1.6), 반올림 후 min(콤보,20)×5 추가.
- 서버는 세션·시간·단어 순서·중복 완료를 확인하고 입력 기록으로 점수를 재계산합니다. 클라이언트 입력 기록을 신뢰하는 부분이 있어 전문적인 부정행위 방지 시스템은 아닙니다.
- 랭킹은 난이도·언어별 상위 30개, 방명록은 최근 60개를 보여줍니다. 게임 한 판(세션)당 한 번만 등록할 수 있고, 잡은 친구가 없으면 방명록만 남길 수 있습니다.
- 닉네임 1~12자, 방명록 1~140자. SQL 매개변수 처리, 화면 textContent 렌더링, 요청 크기 제한을 적용합니다.
- 난이도·언어·소리 설정은 현재 브라우저에만 남습니다.
- 학습용 소규모 서버입니다. 회원 인증·대규모 트래픽 처리는 포함하지 않습니다.

## 7. AI·참고자료 활용 내역
- Codex: 과제 요구사항 분석, SVG/CSS 디자인, 게임·API·YAML·README 초안 작성과 실행 검증 지원
- Claude Code: Three.js 3D 화면 재작성, 랭킹·방명록 패널과 통합 등록, ConfigMap 자동 분할 build.py 작성
- three.js r160 (MIT): https://threejs.org
- 타건음: Pixabay "spacebar click keyboard" https://pixabay.com/sound-effects/film-special-effects-spacebar-click-keyboard-199448/
- 배경 그림: 직접 준비한 잔디밭 이미지(오른쪽 테두리를 잘라 WebP로 변환)
- 캐릭터·프로필 이미지: 현재는 자리표시용 그림이며 직접 준비한 이미지로 교체
- 제공된 과제 안내: 나만의 컨테이너 만들기, 3~10쪽
- 제공된 강의자료: 실제 운영 환경 고려사항, OpenShift 실습(2), 핸즈온 워크샵 매뉴얼
- https://kubernetes.io/docs/concepts/configuration/configmap/
- https://kubernetes.io/docs/concepts/storage/persistent-volumes/
- https://docs.python.org/3/library/sqlite3.html
- https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing
- https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay

제출 전 실제 실행 결과를 직접 확인하고, YAML 각 항목의 역할을 설명할 수 있도록 검토합니다.
