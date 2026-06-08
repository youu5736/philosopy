# GitHub Desktop 반영용 파일

이번 수정본에는 검색 시스템 복구, 키워드 관련성 검증, Gemini 실패 시 화면 깨짐 방지, 첫 화면 이용 방법 영상 추가가 포함되어 있습니다.

## 포함 파일
- .local-static-server.cjs
- artifacts/api-server/src/routes/recommend/index.ts
- artifacts/philosophy-librarian/src/pages/recommend.tsx
- artifacts/philosophy-librarian/src/pages/home.tsx
- artifacts/philosophy-librarian/src/assets/videos/how-to-use.mp4

## 사용 방법
1. GitHub Desktop에서 `youu5736/philosopy` 저장소를 엽니다.
2. 이 폴더 안의 파일들을 GitHub 저장소 루트에 덮어씁니다.
3. GitHub Desktop에서 변경 파일을 확인합니다.
4. Commit message: `Add homepage how-to video and fix search stability`
5. Commit to main 후 Push origin을 누릅니다.
6. Render에서 Manual Deploy -> Deploy latest commit을 누릅니다.

## Render 환경변수
Gemini API 키는 GitHub에 올리지 말고 Render Environment Variables에서만 설정하세요.
