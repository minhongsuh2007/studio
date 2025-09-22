
# AstroStacker API Guide

This document provides instructions on how to use the AstroStacker API for aligning and stacking astrophotography images.

## Endpoint: `/api/stack`

- **Method:** `POST`
- **Description:** Takes a list of image URLs, downloads them, aligns them based on detected star patterns, and stacks them into a single final image.
- **Authentication:** None. This endpoint is open.

---

### Request Body

The request must be a JSON object with the following properties:

| Parameter         | Type     | Required | Default     | Description                                                                                             |
|-------------------|----------|----------|-------------|---------------------------------------------------------------------------------------------------------|
| `imageUrls`       | `Array`  | Yes      | -           | An array of strings, where each string is a publicly accessible URL to an image. Minimum of 2 URLs.         |
| `alignmentMethod` | `String` | No       | `consensus` | The alignment strategy. Options: `standard`, `consensus`, `planetary`, `dumb`.                          |
| `stackingMode`    | `String` | No       | `median`    | The pixel blending mode. Options: `average`, `median`, `sigma`, `laplacian`.                            |

**Example JSON Body:**
```json
{
  "imageUrls": [
    "https://live.staticflickr.com/65535/53416674892_1559863495_o.jpg",
    "https://live.staticflickr.com/65535/53417994043_57b186032c_o.jpg",
    "https://live.staticflickr.com/65535/53418104974_a896a2c0a9_o.jpg"
  ],
  "alignmentMethod": "consensus",
  "stackingMode": "median"
}
```

---

### Success Response (200 OK)

If successful, the API returns a JSON object containing the final stacked image and metadata.

| Parameter         | Type     | Description                                                                  |
|-------------------|----------|------------------------------------------------------------------------------|
| `message`         | `String` | A success message indicating how many images were stacked.                   |
| `stackedImageUrl` | `String` | A base64-encoded Data URL (`data:image/png;base64,...`) of the final image.  |
| `width`           | `Number` | The width of the output image in pixels.                                     |
| `height`          | `Number` | The height of the output image in pixels.                                    |
| `logs`            | `Array`  | An array of strings detailing the processing steps and any warnings.         |

---

### Error Response (4xx or 5xx)

If an error occurs, the API returns a JSON object with an error message.

| Parameter | Type     | Description                                        |
|-----------|----------|----------------------------------------------------|
| `error`   | `String` | A summary of the error.                            |
| `details` | `String` | (Optional) More specific details about the error.  |
| `logs`    | `Array`  | (Optional) Processing logs leading up to the error.|

---

### Example `curl` Command

Replace `YOUR_PUBLIC_APP_URL` with the actual URL of your deployed application.

```bash
curl -X POST https://YOUR_PUBLIC_APP_URL/api/stack \
-H "Content-Type: application/json" \
-d '{
  "imageUrls": [
    "https://live.staticflickr.com/65535/53416674892_1559863495_o.jpg",
    "https://live.staticflickr.com/65535/53417994043_57b186032c_o.jpg"
  ],
  "alignmentMethod": "consensus",
  "stackingMode": "median"
}'
```
