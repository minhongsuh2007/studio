# AstroStacker API 사용 가이드

AstroStacker의 핵심 기능인 이미지 스태킹을 외부에서 프로그래밍 방식으로 사용할 수 있습니다.

## 엔드포인트

- **URL:** `/api/stack`
- **Method:** `POST`
- **Content-Type:** `application/json`

## 인증

API를 사용하려면 API 키를 통한 인증이 필요합니다. `.env` 파일에 저장된 키를 `Authorization` 헤더에 담아 요청해야 합니다.

- **Header:** `Authorization: Bearer YOUR_API_KEY`

`YOUR_API_KEY` 부분을 `.env` 파일의 `ASTROSTACKER_API_KEYS`에 설정된 값으로 교체하세요.

## 요청 본문 (Request Body)

스태킹할 이미지와 설정을 JSON 형식으로 전송합니다.

```json
{
  "imageUrls": [
    "https://.../image1.jpg",
    "https://.../image2.png",
    "https://.../image3.tif"
  ],
  "alignmentMethod": "consensus",
  "stackingMode": "median"
}
```

### 파라미터 설명

- **`imageUrls`** (배열, 필수): 스태킹할 이미지들의 공개적으로 접근 가능한 URL 목록입니다. 최소 2개 이상의 URL이 필요합니다.
- **`alignmentMethod`** (문자열, 선택): 정렬 방법을 지정합니다. 기본값은 `consensus`입니다.
  - `standard`: 가장 기본적인 2-star 정렬
  - `consensus`: AI 패턴 또는 밝기 기반의 합의 정렬
  - `planetary`: 행성 표면 특징 기반 정렬
  - `dumb`: 가장 밝은 픽셀 기반의 단순 정렬
- **`stackingMode`** (문자열, 선택): 스태킹 모드를 지정합니다. 기본값은 `median`입니다.
  - `average`: 평균값
  - `median`: 중앙값
  - `sigma`: 시그마 클리핑
  - `laplacian`: 가장 선명한 픽셀 선택 (행성용)


## 성공 응답 (Success Response)

요청이 성공하면 `200 OK` 상태 코드와 함께 JSON 객체가 반환됩니다.

```json
{
  "message": "Successfully stacked 3 images.",
  "stackedImageUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgA...",
  "width": 1920,
  "height": 1080
}
```

- **`stackedImageUrl`**: 최종 스태킹된 이미지를 **Data URI** 형식으로 포함한 URL 링크입니다. 이 링크는 웹 브라우저에서 직접 열거나 `<img>` 태그의 `src`로 바로 사용할 수 있습니다.
- **`width` / `height`**: 결과 이미지의 가로/세로 크기입니다.

## 오류 응답 (Error Response)

- `401 Unauthorized`: API 키가 잘못되었거나 제공되지 않은 경우
- `400 Bad Request`: `imageUrls`가 2개 미만이거나 형식이 잘못된 경우
- `500 Internal Server Error`: 서버 내부에서 이미지 처리 중 오류가 발생한 경우

## 사용 예시 (`curl` 사용)

터미널에서 아래 명령어를 실행하여 API를 테스트할 수 있습니다. `https://YOUR_PUBLIC_APP_URL` 부분을 현재 개발 환경의 실제 공개 URL로, `YOUR_API_KEY`를 `.env` 파일에 설정한 키로, 그리고 이미지 URL을 실제 값으로 바꾸세요.

```bash
# YOUR_PUBLIC_APP_URL과 YOUR_API_KEY, 실제 이미지 URL을 자신의 값으로 바꾸세요.
curl -X POST https://YOUR_PUBLIC_APP_URL/api/stack \
-H "Content-Type: application/json" \
-H "Authorization: Bearer YOUR_API_KEY" \
-d '{
  "imageUrls": [
    "https://live.staticflickr.com/65535/53416674892_1559863495_o.jpg",
    "https://live.staticflickr.com/65535/53417994043_57b186032c_o.jpg"
  ],
  "alignmentMethod": "standard",
  "stackingMode": "median"
}'
```

이 요청은 2개의 이미지를 `standard` 정렬과 `median` 모드로 스태킹한 후, 결과 이미지의 Data URI가 포함된 URL 링크를 반환합니다.