---
type: llm
weight: 2
---

The user asked for a 20-second vertical launch video for an app and wants to hear what is needed and how it will be made before anything is built.

PASS if the reply does all three:
1. Asks the user for at least three concrete inputs from this list: the real product screenshots, logo or site assets; brand colors and fonts; a visual reference (a frame, a video or a style); music (a supplied track or permission to synthesize one); output formats or aspect ratios beyond 9:16; the key message, features or call to action.
2. Describes making the video from code: frames are rendered by a program (for example a canvas or HTML page with a seek(t) or draw(t) function, or a code framework such as Remotion) and encoded to MP4, not assembled in a video editor or template app.
3. Includes a checkpoint before the final render, such as approving a shot list or reviewing stills or a contact sheet.

FAIL if it claims a video has already been made, gives only generic advice with no concrete production plan, or asks the user for nothing.
