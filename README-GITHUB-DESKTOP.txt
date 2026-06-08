# GitHub Desktop 반영용 파일

이 폴더에는 이번 수정에 필요한 파일 2개가 원래 경로 그대로 들어 있습니다.

## 포함 파일
- artifacts/api-server/src/routes/recommend/index.ts
- artifacts/philosophy-librarian/src/pages/recommend.tsx

## 사용 방법
1. GitHub Desktop에서 `youu5736/philosopy` 저장소를 엽니다.
2. 이 폴더 안의 `artifacts` 폴더를 GitHub 저장소 루트에 덮어씌웁니다.
3. GitHub Desktop에서 변경 파일 2개를 확인합니다.
4. Commit message: `Fix Gemini keyword and chat stability`
5. Commit to main 후 Push origin을 누릅니다.
6. Render에서 Manual Deploy -> Deploy latest commit을 누릅니다.

## 주의
Gemini API 키는 GitHub에 올리지 말고 Render Environment Variables에서만 바꾸세요.
