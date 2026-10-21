## How the frozen edge rule loses pinches

| Input | Threshold | Recall | False/min | False fires just before a pinch's window | Missed pinches with such a fire |
|---|---:|---:|---:|---:|---:|
| ppg | 0.3 | 0.243 | 24.26 | 26.8% | 66.6% |
| ppg | 0.5 | 0.413 | 15.09 | 31.4% | 62.0% |
| ppg | 0.7 | 0.378 | 5.92 | 33.7% | 24.4% |
| ppg+imu | 0.3 | 0.209 | 20.82 | 33.4% | 67.7% |
| ppg+imu | 0.5 | 0.350 | 11.25 | 42.9% | 56.9% |
| ppg+imu | 0.7 | 0.385 | 3.97 | 46.0% | 22.6% |

## Most pinches caught within a false-activation budget

| Input | Rule | <= 0.5/min | <= 1/min | <= 2/min | <= 5/min | Latency at <= 2/min |
|---|---|---:|---:|---:|---:|---:|
| ppg | edge | 0.067 (t 0.95) | 0.149 (t 0.90) | 0.230 (t 0.85) | 0.343 (t 0.75) | 845 ms |
| ppg | debounce | 0.027 (t 0.95) | 0.096 (t 0.90) | 0.243 (t 0.80) | 0.359 (t 0.70) | 890 ms |
| ppg | smooth | 0.043 (t 0.95) | 0.124 (t 0.90) | 0.203 (t 0.85) | 0.383 (t 0.70) | 879 ms |
| ppg | peak | 0.034 (t 0.95) | 0.103 (t 0.90) | 0.249 (t 0.80) | 0.379 (t 0.70) | 910 ms |
| ppg+imu | edge | 0.115 (t 0.95) | 0.209 (t 0.90) | 0.340 (t 0.80) | 0.385 (t 0.70) | 820 ms |
| ppg+imu | debounce | 0.160 (t 0.90) | 0.241 (t 0.85) | 0.368 (t 0.75) | 0.466 (t 0.60) | 865 ms |
| ppg+imu | smooth | 0.183 (t 0.90) | 0.271 (t 0.85) | 0.335 (t 0.80) | 0.431 (t 0.65) | 855 ms |
| ppg+imu | peak | 0.162 (t 0.90) | 0.245 (t 0.85) | 0.378 (t 0.75) | 0.509 (t 0.60) | 910 ms |
