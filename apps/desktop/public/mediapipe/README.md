# MediaPipe hand landmarker model

`hand_landmarker.task` is Google's MediaPipe Hand Landmarker model (float16), downloaded from
`https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`.
SHA-256: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.

Licence: Apache-2.0 (MediaPipe). It is committed so the app works offline and never fetches a model at run time.
The WebAssembly runtime that runs it is not committed: `vite.config.ts` serves it from `node_modules/@mediapipe/tasks-vision`
in development and copies it into the build.
