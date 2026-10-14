# MediaPipe hand landmarker model

`hand_landmarker.task` is Google's MediaPipe Hand Landmarker model (float16), downloaded from
`https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`.
SHA-256: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.

Licence: Apache-2.0 (MediaPipe). It is committed so the app works offline and never fetches a model at run time.
The WebAssembly runtime that runs it is not committed: `vite.config.ts` serves it from `node_modules/@mediapipe/tasks-vision`
in development and copies it into the build.

## MediaPipe gesture recognizer model

`gesture_recognizer.task` is Google's MediaPipe Gesture Recognizer (float16), downloaded from
`https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task`
(8,373,440 bytes). SHA-256: `97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482`.

Licence: Apache-2.0 (MediaPipe). It contains the same hand landmarker plus a small classifier trained only on hand
gestures, which names seven: Closed_Fist, Open_Palm, Pointing_Up, Thumb_Down, Thumb_Up, Victory and ILoveYou ("None"
when it sees none of them). The camera loads it first, so one pass gives the hand landmarks and the pretrained reading;
if it cannot be loaded the plain `hand_landmarker.task` above is used and gestures simply have no pretrained reading.
