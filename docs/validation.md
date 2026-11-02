# LUT validation — Phase 1c

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).

References are public full `simulate()` runs with exactly the bake's film/print, sRGB
CCTF boundary, input gain, fixed camera EV, normalized/compensated print exposure,
database neutral filters, scanner white/black normalization, positive-film route, and
CAM16-UCS output handling. Grain, halation/scatter, diffusion, blur, glare, DIR spatial
diffusion, unsharp masking, auto exposure, and other spatial/stochastic effects are off.
**There is no project-owned tone curve or post-simulation levels transform.**

Natural images are the six phone photos plus the ProPhoto-derived portrait. The IT8
chart and synthetic target are reported separately. Subsets use reference CIE Lab:
shadows L*<20, highlights L*>85, saturated colours C*ab>50. Quantization-only error
compares float trilinear output from original versus 8-bit-rounded cube nodes; it does
not include interpolation error or final 8-bit render-target rounding.

## Acceptance summary

- Selected **N=33**, tiled grid **264×
165**, 8 columns; package **290.1 KiB**.
- Stocks: **11**; images per stock: **9**.
- Natural-image limits: each stock's pooled mean <1.0 and p95 <3.0 dE2000: **PASS**.
- Near-white non-decreasing response with no material LUT flat top: **PASS**.
- Strict-rise exceptions caused solely by sub-one-code 8-bit rounding: **ektar100**.
- Package <1.5 MiB: **PASS**.

### Overall natural-image and subset fidelity (selected N)

These are exact pixel-pooled results across all 11 stocks and seven natural images,
not averages of per-image percentiles. Subsets are defined independently in each full
physical reference, so their pixels can overlap.

| Population | Pixels (coverage) | Mean dE2000 | p95 | p99 | MAX |
|---|---:|---:|---:|---:|---:|
| All natural pixels | 86461364 (100.00%) | 0.2829 | 0.6140 | 0.8296 | 1.6896 |
| shadows_Lstar_lt_20 | 28673956 (33.16%) | 0.3086 | 0.6747 | 0.9094 | 1.6896 |
| highlights_Lstar_gt_85 | 2722230 (3.15%) | 0.3117 | 0.6346 | 0.8089 | 1.2394 |
| saturated_Cstarab_gt_50 | 617139 (0.71%) | 0.1697 | 0.3438 | 0.4740 | 0.8590 |

8-bit node quantization only (99 stock×image pairs): pixel-weighted mean **0.1319**, worst image p95 **0.7472**, global MAX **0.8122 dE2000**; mean absolute code error **0.4068**.

### Contact-sheet visual review

Both final sheets were inspected after generation. The FULL PHYSICAL and LUT columns show no
visible exposure, hue, or geometry discrepancy; the phone photos remain plausibly exposed, and
the direct-scan slides no longer show the exploratory median-EV underexposure. Ektar is visibly
more contrasty/saturated, as expected from its physical profile. Across the six triplets, FULL↔LUT
mean absolute error spans **0.1735–0.2560 codes**, mean dE2000 **0.2039–0.2910**, and maximum
absolute error **1–3 codes**. `docs/lut-preview.jpg` is 749,981 bytes and
`docs/lut-all-stocks.jpg` is 518,555 bytes, both below 800 KB.

### Resolution / size / error trade-off

Eligibility requires package <1.5 MiB, natural targets passing, and every stock's
natural p95 within 0.1 dE2000 of the same stock at N=65. The smallest eligible N wins.

| N | Grid | Package KiB | Mean of stock natural means | Worst stock mean | Worst stock p95 | Max p95 increase vs 65 | Eligible |
|---:|---|---:|---:|---:|---:|---:|:---:|
| 33 | 264×165 | 290.1 | 0.2829 | 0.2912 | 0.6463 | +0.0822 | yes |
| 49 | 392×343 | 737.7 | 0.2725 | 0.2914 | 0.6194 | +0.0433 | yes |
| 65 | 520×585 | 1451.0 | 0.2673 | 0.2796 | 0.6162 | +0.0000 | yes |

### Per-stock pooled natural-image results (selected N)

| Stock | Mean dE2000 | p95 | p99 | MAX | Mean target | p95 target |
|---|---:|---:|---:|---:|:---:|:---:|
| Kodak Portra 400 | 0.2781 | 0.6117 | 0.8214 | 1.6130 | PASS | PASS |
| Kodak Portra 160 | 0.2862 | 0.6317 | 0.8412 | 1.4755 | PASS | PASS |
| Kodak Gold 200 | 0.2821 | 0.5965 | 0.8223 | 1.3824 | PASS | PASS |
| Kodak Ultramax 400 | 0.2903 | 0.6103 | 0.8066 | 1.5719 | PASS | PASS |
| Kodak Ektar 100 | 0.2606 | 0.5702 | 0.7716 | 1.4753 | PASS | PASS |
| Fujifilm Velvia 100 | 0.2912 | 0.6463 | 0.8759 | 1.6896 | PASS | PASS |
| Fujifilm Provia 100F | 0.2840 | 0.5946 | 0.7780 | 1.4601 | PASS | PASS |
| Kodak Kodachrome 64 | 0.2848 | 0.6114 | 0.8166 | 1.3954 | PASS | PASS |
| Fujifilm Pro 400H | 0.2786 | 0.6161 | 0.8260 | 1.5538 | PASS | PASS |
| Kodak Vision3 250D | 0.2861 | 0.6229 | 0.8429 | 1.3640 | PASS | PASS |
| Kodak Vision3 500T | 0.2898 | 0.6291 | 0.8492 | 1.4372 | PASS | PASS |

## Per-stock, per-image metrics (selected N)

| Stock | Image | Kind | Mean | p95 | p99 | MAX dE2000 | MAE 8-bit | Quant-only mean/p95/MAX |
|---|---|---|---:|---:|---:|---:|---:|---:|
| Kodak Portra 400 | phone_p1015 | phone | 0.2062 | 0.4735 | 0.6673 | 1.4544 | 0.8509 | 0.0926/0.2221/0.6830 |
| Kodak Portra 400 | phone_p1025 | phone | 0.3209 | 0.6778 | 0.8969 | 1.6130 | 0.9620 | 0.1506/0.3350/0.6931 |
| Kodak Portra 400 | phone_p1043 | phone | 0.2716 | 0.6092 | 0.8516 | 1.6130 | 0.8924 | 0.1245/0.2865/0.6931 |
| Kodak Portra 400 | phone_p1062 | phone | 0.3050 | 0.6076 | 0.7617 | 1.2548 | 0.8692 | 0.1370/0.3064/0.6275 |
| Kodak Portra 400 | phone_p237 | phone | 0.2428 | 0.5486 | 0.7600 | 1.6130 | 0.8960 | 0.1185/0.2427/0.6738 |
| Kodak Portra 400 | phone_p433 | phone | 0.3267 | 0.6854 | 0.8695 | 1.6130 | 0.8608 | 0.1438/0.3178/0.6738 |
| Kodak Portra 400 | portrait | portrait | 0.2696 | 0.6160 | 0.8112 | 1.3549 | 0.9524 | 0.1399/0.3020/0.6738 |
| Kodak Portra 400 | chart | chart | 0.2892 | 0.5188 | 0.7921 | 1.2816 | 0.8779 | 0.2159/0.3175/0.6738 |
| Kodak Portra 400 | synthetic | synthetic | 0.2143 | 0.5620 | 0.8105 | 1.0209 | 0.9085 | 0.1071/0.3259/0.6738 |
| Kodak Portra 160 | phone_p1015 | phone | 0.2109 | 0.4914 | 0.6846 | 1.4277 | 0.8547 | 0.0994/0.2473/0.7630 |
| Kodak Portra 160 | phone_p1025 | phone | 0.3134 | 0.6617 | 0.8779 | 1.4612 | 0.8989 | 0.1395/0.3165/0.7162 |
| Kodak Portra 160 | phone_p1043 | phone | 0.2739 | 0.6055 | 0.8207 | 1.4612 | 0.8804 | 0.1336/0.3084/0.7369 |
| Kodak Portra 160 | phone_p1062 | phone | 0.3129 | 0.6603 | 0.8564 | 1.4755 | 0.8837 | 0.1409/0.3486/0.7148 |
| Kodak Portra 160 | phone_p237 | phone | 0.2593 | 0.5425 | 0.7601 | 1.4612 | 0.8780 | 0.1318/0.2714/0.7129 |
| Kodak Portra 160 | phone_p433 | phone | 0.3367 | 0.7514 | 0.8736 | 1.4277 | 0.8631 | 0.1481/0.3003/0.6964 |
| Kodak Portra 160 | portrait | portrait | 0.3042 | 0.6489 | 0.9171 | 1.3998 | 0.9307 | 0.1418/0.3133/0.7096 |
| Kodak Portra 160 | chart | chart | 0.2542 | 0.4959 | 0.7007 | 1.3286 | 0.7443 | 0.1814/0.2526/0.6390 |
| Kodak Portra 160 | synthetic | synthetic | 0.2067 | 0.5162 | 0.7349 | 1.0822 | 0.8701 | 0.0942/0.2466/0.5228 |
| Kodak Gold 200 | phone_p1015 | phone | 0.2062 | 0.4616 | 0.6484 | 1.3749 | 0.8440 | 0.0900/0.2166/0.6833 |
| Kodak Gold 200 | phone_p1025 | phone | 0.2817 | 0.6055 | 0.8296 | 1.3742 | 0.9613 | 0.1217/0.2669/0.8122 |
| Kodak Gold 200 | phone_p1043 | phone | 0.2832 | 0.5921 | 0.8128 | 1.3824 | 0.9303 | 0.1316/0.3172/0.8122 |
| Kodak Gold 200 | phone_p1062 | phone | 0.2922 | 0.5997 | 0.8538 | 1.3124 | 0.8798 | 0.1174/0.2479/0.8122 |
| Kodak Gold 200 | phone_p237 | phone | 0.2865 | 0.5184 | 0.7497 | 1.3742 | 0.9150 | 0.1653/0.3528/0.8122 |
| Kodak Gold 200 | phone_p433 | phone | 0.3359 | 0.7412 | 0.9324 | 1.3742 | 0.9183 | 0.1592/0.3767/0.8122 |
| Kodak Gold 200 | portrait | portrait | 0.2948 | 0.5298 | 0.6778 | 1.3549 | 0.9174 | 0.1340/0.3028/0.7221 |
| Kodak Gold 200 | chart | chart | 0.3304 | 0.4899 | 0.7194 | 1.1353 | 0.8961 | 0.2559/0.4115/0.6410 |
| Kodak Gold 200 | synthetic | synthetic | 0.1993 | 0.4777 | 0.7017 | 1.0361 | 0.9131 | 0.0984/0.2470/0.6410 |
| Kodak Ultramax 400 | phone_p1015 | phone | 0.2108 | 0.4871 | 0.6738 | 1.4233 | 0.8635 | 0.0994/0.2406/0.6398 |
| Kodak Ultramax 400 | phone_p1025 | phone | 0.2960 | 0.6317 | 0.8336 | 1.5719 | 0.9571 | 0.1269/0.2795/0.6041 |
| Kodak Ultramax 400 | phone_p1043 | phone | 0.2840 | 0.6056 | 0.8201 | 1.5719 | 0.9278 | 0.1345/0.3082/0.6830 |
| Kodak Ultramax 400 | phone_p1062 | phone | 0.3195 | 0.6481 | 0.7887 | 1.3362 | 0.8998 | 0.1375/0.2863/0.5229 |
| Kodak Ultramax 400 | phone_p237 | phone | 0.2991 | 0.5249 | 0.7463 | 1.5719 | 0.9202 | 0.1591/0.3704/0.5533 |
| Kodak Ultramax 400 | phone_p433 | phone | 0.3352 | 0.6929 | 0.9175 | 1.5719 | 0.9102 | 0.1392/0.3116/0.6041 |
| Kodak Ultramax 400 | portrait | portrait | 0.2856 | 0.6013 | 0.7120 | 1.1943 | 1.0135 | 0.1219/0.2370/0.4956 |
| Kodak Ultramax 400 | chart | chart | 0.2952 | 0.4903 | 0.7281 | 1.1568 | 0.9565 | 0.2208/0.3318/0.5618 |
| Kodak Ultramax 400 | synthetic | synthetic | 0.2070 | 0.5181 | 0.7436 | 1.1029 | 0.9328 | 0.1006/0.2676/0.5533 |
| Kodak Ektar 100 | phone_p1015 | phone | 0.2049 | 0.4699 | 0.6709 | 1.4753 | 0.8894 | 0.0904/0.2177/0.6612 |
| Kodak Ektar 100 | phone_p1025 | phone | 0.3115 | 0.6715 | 0.9054 | 1.4753 | 0.9935 | 0.1273/0.2809/0.6612 |
| Kodak Ektar 100 | phone_p1043 | phone | 0.2362 | 0.4891 | 0.6625 | 1.4142 | 0.9466 | 0.1098/0.2352/0.6555 |
| Kodak Ektar 100 | phone_p1062 | phone | 0.2783 | 0.5627 | 0.7505 | 1.0800 | 0.9656 | 0.1263/0.2624/0.5299 |
| Kodak Ektar 100 | phone_p237 | phone | 0.2260 | 0.4346 | 0.5908 | 1.2036 | 0.9581 | 0.1231/0.2094/0.5318 |
| Kodak Ektar 100 | phone_p433 | phone | 0.3361 | 0.7001 | 0.8586 | 1.2993 | 1.0048 | 0.1348/0.2843/0.5817 |
| Kodak Ektar 100 | portrait | portrait | 0.2078 | 0.4656 | 0.6529 | 1.3251 | 0.8372 | 0.1339/0.2573/0.6183 |
| Kodak Ektar 100 | chart | chart | 0.2393 | 0.4716 | 0.6948 | 1.2101 | 0.9877 | 0.1647/0.2332/0.4703 |
| Kodak Ektar 100 | synthetic | synthetic | 0.2041 | 0.4691 | 0.7019 | 0.9987 | 0.9743 | 0.0948/0.2164/0.4003 |
| Fujifilm Velvia 100 | phone_p1015 | phone | 0.2142 | 0.5091 | 0.7056 | 1.6896 | 0.8931 | 0.1018/0.2680/0.6662 |
| Fujifilm Velvia 100 | phone_p1025 | phone | 0.3066 | 0.6871 | 0.9253 | 1.5468 | 1.0765 | 0.1203/0.2722/0.6350 |
| Fujifilm Velvia 100 | phone_p1043 | phone | 0.2905 | 0.6427 | 0.9285 | 1.6896 | 1.0176 | 0.1210/0.2800/0.6454 |
| Fujifilm Velvia 100 | phone_p1062 | phone | 0.2946 | 0.6153 | 0.7702 | 1.1277 | 0.8799 | 0.1508/0.3657/0.6561 |
| Fujifilm Velvia 100 | phone_p237 | phone | 0.2746 | 0.5251 | 0.7491 | 1.5221 | 0.8859 | 0.1560/0.2814/0.6350 |
| Fujifilm Velvia 100 | phone_p433 | phone | 0.3618 | 0.8337 | 1.0961 | 1.5221 | 1.0130 | 0.1681/0.3495/0.6662 |
| Fujifilm Velvia 100 | portrait | portrait | 0.3006 | 0.6343 | 0.8926 | 1.5221 | 1.0448 | 0.1260/0.2882/0.5377 |
| Fujifilm Velvia 100 | chart | chart | 0.4523 | 0.6662 | 0.7164 | 1.3219 | 1.0781 | 0.3849/0.6662/0.6662 |
| Fujifilm Velvia 100 | synthetic | synthetic | 0.2057 | 0.5542 | 0.8323 | 1.3219 | 0.9662 | 0.0902/0.2590/0.6662 |
| Fujifilm Provia 100F | phone_p1015 | phone | 0.2285 | 0.5029 | 0.6726 | 1.4601 | 0.8369 | 0.1083/0.2497/0.7753 |
| Fujifilm Provia 100F | phone_p1025 | phone | 0.2904 | 0.6355 | 0.8351 | 1.4601 | 0.8686 | 0.1367/0.3044/0.7753 |
| Fujifilm Provia 100F | phone_p1043 | phone | 0.2773 | 0.5832 | 0.7971 | 1.4601 | 0.8884 | 0.1283/0.2981/0.7753 |
| Fujifilm Provia 100F | phone_p1062 | phone | 0.2951 | 0.5943 | 0.7467 | 1.0743 | 0.8411 | 0.1409/0.2755/0.5102 |
| Fujifilm Provia 100F | phone_p237 | phone | 0.2868 | 0.5531 | 0.7245 | 1.3308 | 0.8562 | 0.1553/0.3325/0.7179 |
| Fujifilm Provia 100F | phone_p433 | phone | 0.3129 | 0.6394 | 0.8079 | 1.4601 | 0.8324 | 0.1440/0.3157/0.7753 |
| Fujifilm Provia 100F | portrait | portrait | 0.3076 | 0.6311 | 0.7896 | 1.4601 | 0.9974 | 0.1499/0.3079/0.7670 |
| Fujifilm Provia 100F | chart | chart | 0.4993 | 0.7472 | 0.7472 | 1.2836 | 1.0803 | 0.4310/0.7472/0.7472 |
| Fujifilm Provia 100F | synthetic | synthetic | 0.2113 | 0.5515 | 0.6778 | 0.9367 | 0.8599 | 0.1009/0.2488/0.7472 |
| Kodak Kodachrome 64 | phone_p1015 | phone | 0.2340 | 0.5088 | 0.6735 | 1.3954 | 0.8458 | 0.1079/0.2469/0.7476 |
| Kodak Kodachrome 64 | phone_p1025 | phone | 0.2878 | 0.6227 | 0.8215 | 1.3954 | 0.8922 | 0.1258/0.2743/0.7410 |
| Kodak Kodachrome 64 | phone_p1043 | phone | 0.2755 | 0.5814 | 0.7581 | 1.3954 | 0.8974 | 0.1278/0.2781/0.7476 |
| Kodak Kodachrome 64 | phone_p1062 | phone | 0.3020 | 0.6120 | 0.7473 | 1.0918 | 0.8623 | 0.1374/0.2822/0.5624 |
| Kodak Kodachrome 64 | phone_p237 | phone | 0.2605 | 0.5582 | 0.7493 | 1.2599 | 0.8884 | 0.1299/0.2600/0.6111 |
| Kodak Kodachrome 64 | phone_p433 | phone | 0.3463 | 0.7650 | 0.8934 | 1.2666 | 0.8498 | 0.1642/0.3416/0.7410 |
| Kodak Kodachrome 64 | portrait | portrait | 0.2896 | 0.5791 | 0.7549 | 1.3172 | 1.0433 | 0.1561/0.3175/0.6388 |
| Kodak Kodachrome 64 | chart | chart | 0.2252 | 0.4871 | 0.6817 | 1.3173 | 0.6467 | 0.1544/0.2312/0.6158 |
| Kodak Kodachrome 64 | synthetic | synthetic | 0.2107 | 0.5540 | 0.7655 | 1.2599 | 0.8775 | 0.1009/0.2485/0.6065 |
| Fujifilm Pro 400H | phone_p1015 | phone | 0.2107 | 0.4900 | 0.6852 | 1.5538 | 0.8550 | 0.0988/0.2475/0.7001 |
| Fujifilm Pro 400H | phone_p1025 | phone | 0.2909 | 0.6210 | 0.8288 | 1.5538 | 0.9493 | 0.1283/0.2900/0.6700 |
| Fujifilm Pro 400H | phone_p1043 | phone | 0.2734 | 0.6111 | 0.8417 | 1.5538 | 0.9237 | 0.1270/0.2725/0.7558 |
| Fujifilm Pro 400H | phone_p1062 | phone | 0.3220 | 0.6605 | 0.8036 | 1.5538 | 0.8921 | 0.1455/0.3159/0.7378 |
| Fujifilm Pro 400H | phone_p237 | phone | 0.2561 | 0.5515 | 0.7817 | 1.5538 | 0.8720 | 0.1347/0.2595/0.5628 |
| Fujifilm Pro 400H | phone_p433 | phone | 0.3279 | 0.7117 | 0.9550 | 1.5538 | 0.8975 | 0.1478/0.3229/0.6192 |
| Fujifilm Pro 400H | portrait | portrait | 0.2618 | 0.5810 | 0.7061 | 1.2926 | 0.9972 | 0.1291/0.2477/0.6192 |
| Fujifilm Pro 400H | chart | chart | 0.3860 | 0.5418 | 0.7579 | 1.3517 | 0.8661 | 0.3091/0.5168/0.6144 |
| Fujifilm Pro 400H | synthetic | synthetic | 0.2023 | 0.5159 | 0.6905 | 1.1426 | 0.9074 | 0.0948/0.2609/0.6144 |
| Kodak Vision3 250D | phone_p1015 | phone | 0.2245 | 0.5011 | 0.6683 | 1.3640 | 0.8486 | 0.1036/0.2337/0.7376 |
| Kodak Vision3 250D | phone_p1025 | phone | 0.2875 | 0.6180 | 0.8065 | 1.3640 | 0.9394 | 0.1210/0.2629/0.6355 |
| Kodak Vision3 250D | phone_p1043 | phone | 0.2743 | 0.5954 | 0.8025 | 1.3640 | 0.9004 | 0.1216/0.2707/0.7376 |
| Kodak Vision3 250D | phone_p1062 | phone | 0.3242 | 0.6860 | 0.9383 | 1.3640 | 0.8767 | 0.1502/0.3219/0.5851 |
| Kodak Vision3 250D | phone_p237 | phone | 0.2889 | 0.5991 | 0.7875 | 1.3640 | 0.8920 | 0.1567/0.2907/0.6355 |
| Kodak Vision3 250D | phone_p433 | phone | 0.3245 | 0.6821 | 0.8812 | 1.3640 | 0.8983 | 0.1424/0.3107/0.6355 |
| Kodak Vision3 250D | portrait | portrait | 0.2736 | 0.5669 | 0.8375 | 1.2540 | 0.9524 | 0.1225/0.2903/0.5851 |
| Kodak Vision3 250D | chart | chart | 0.3168 | 0.4836 | 0.6648 | 1.3547 | 1.0954 | 0.2435/0.3841/0.5173 |
| Kodak Vision3 250D | synthetic | synthetic | 0.2120 | 0.4898 | 0.7207 | 0.9598 | 0.9195 | 0.0971/0.2515/0.5655 |
| Kodak Vision3 500T | phone_p1015 | phone | 0.2328 | 0.5354 | 0.7035 | 1.4372 | 0.8518 | 0.1099/0.2653/0.6915 |
| Kodak Vision3 500T | phone_p1025 | phone | 0.2959 | 0.6271 | 0.8423 | 1.4372 | 0.9551 | 0.1278/0.2858/0.6505 |
| Kodak Vision3 500T | phone_p1043 | phone | 0.2757 | 0.5937 | 0.7901 | 1.4372 | 0.8959 | 0.1262/0.2845/0.6173 |
| Kodak Vision3 500T | phone_p1062 | phone | 0.3139 | 0.6773 | 0.8556 | 1.2681 | 0.8785 | 0.1353/0.2934/0.6505 |
| Kodak Vision3 500T | phone_p237 | phone | 0.2844 | 0.5856 | 0.8078 | 1.4372 | 0.8880 | 0.1527/0.3477/0.6173 |
| Kodak Vision3 500T | phone_p433 | phone | 0.3392 | 0.7264 | 0.9776 | 1.4372 | 0.9008 | 0.1549/0.3247/0.6915 |
| Kodak Vision3 500T | portrait | portrait | 0.2847 | 0.6057 | 0.8304 | 1.2681 | 0.9816 | 0.1303/0.2782/0.6173 |
| Kodak Vision3 500T | chart | chart | 0.2415 | 0.4944 | 0.7007 | 1.1981 | 0.9021 | 0.1681/0.2366/0.6321 |
| Kodak Vision3 500T | synthetic | synthetic | 0.2180 | 0.5566 | 0.7193 | 1.0052 | 0.9052 | 0.0955/0.2336/0.5808 |

## Reference-defined subsets (selected N)

| Stock | Image | Subset | Pixels (coverage) | Mean | p95 | p99 | MAX dE2000 |
|---|---|---|---:|---:|---:|---:|---:|
| Kodak Portra 400 | phone_p1015 | shadows_Lstar_lt_20 | 79532 (6.63%) | 0.2587 | 0.6192 | 0.8562 | 1.4544 |
| Kodak Portra 400 | phone_p1015 | highlights_Lstar_gt_85 | 6700 (0.56%) | 0.3228 | 0.6564 | 0.7712 | 1.0273 |
| Kodak Portra 400 | phone_p1015 | saturated_Cstarab_gt_50 | 6148 (0.51%) | 0.1750 | 0.3421 | 0.4223 | 0.5762 |
| Kodak Portra 400 | phone_p1025 | shadows_Lstar_lt_20 | 373033 (31.12%) | 0.3930 | 0.7973 | 1.0102 | 1.6130 |
| Kodak Portra 400 | phone_p1025 | highlights_Lstar_gt_85 | 822 (0.07%) | 0.3522 | 0.7602 | 0.7640 | 0.7640 |
| Kodak Portra 400 | phone_p1025 | saturated_Cstarab_gt_50 | 878 (0.07%) | 0.1778 | 0.3507 | 0.4170 | 0.4758 |
| Kodak Portra 400 | phone_p1043 | shadows_Lstar_lt_20 | 526623 (43.93%) | 0.3064 | 0.7062 | 0.9626 | 1.6130 |
| Kodak Portra 400 | phone_p1043 | highlights_Lstar_gt_85 | 2660 (0.22%) | 0.2998 | 0.6204 | 0.8020 | 0.9915 |
| Kodak Portra 400 | phone_p1043 | saturated_Cstarab_gt_50 | 32065 (2.67%) | 0.1722 | 0.3438 | 0.4279 | 0.6306 |
| Kodak Portra 400 | phone_p1062 | shadows_Lstar_lt_20 | 94219 (7.86%) | 0.3206 | 0.6478 | 0.8209 | 1.2548 |
| Kodak Portra 400 | phone_p1062 | highlights_Lstar_gt_85 | 41193 (3.44%) | 0.3101 | 0.5363 | 0.5363 | 0.8571 |
| Kodak Portra 400 | phone_p1062 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Portra 400 | phone_p237 | shadows_Lstar_lt_20 | 555893 (46.37%) | 0.2185 | 0.5750 | 0.8470 | 1.6130 |
| Kodak Portra 400 | phone_p237 | highlights_Lstar_gt_85 | 101 (0.01%) | 0.3503 | 0.6417 | 0.8229 | 0.8280 |
| Kodak Portra 400 | phone_p237 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Portra 400 | phone_p433 | shadows_Lstar_lt_20 | 230842 (19.26%) | 0.3624 | 0.7714 | 1.0060 | 1.6130 |
| Kodak Portra 400 | phone_p433 | highlights_Lstar_gt_85 | 70249 (5.86%) | 0.3347 | 0.7203 | 0.7640 | 0.9915 |
| Kodak Portra 400 | phone_p433 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Portra 400 | portrait | shadows_Lstar_lt_20 | 642077 (96.26%) | 0.2689 | 0.6200 | 0.8112 | 1.3549 |
| Kodak Portra 400 | portrait | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Portra 400 | portrait | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Portra 400 | chart | shadows_Lstar_lt_20 | 15570 (11.20%) | 0.3256 | 0.7221 | 0.9207 | 1.2816 |
| Kodak Portra 400 | chart | highlights_Lstar_gt_85 | 70863 (50.96%) | 0.3216 | 0.3186 | 0.5594 | 0.7353 |
| Kodak Portra 400 | chart | saturated_Cstarab_gt_50 | 6444 (4.63%) | 0.1430 | 0.2771 | 0.3657 | 0.4894 |
| Kodak Portra 400 | synthetic | shadows_Lstar_lt_20 | 31353 (7.97%) | 0.3519 | 0.7773 | 0.8702 | 0.9207 |
| Kodak Portra 400 | synthetic | highlights_Lstar_gt_85 | 2110 (0.54%) | 0.3250 | 0.5951 | 0.7203 | 0.7288 |
| Kodak Portra 400 | synthetic | saturated_Cstarab_gt_50 | 123951 (31.52%) | 0.1397 | 0.2719 | 0.3381 | 0.4431 |
| Kodak Portra 160 | phone_p1015 | shadows_Lstar_lt_20 | 70469 (5.88%) | 0.2750 | 0.6400 | 0.8630 | 1.4277 |
| Kodak Portra 160 | phone_p1015 | highlights_Lstar_gt_85 | 6553 (0.55%) | 0.2916 | 0.6046 | 0.7112 | 1.0026 |
| Kodak Portra 160 | phone_p1015 | saturated_Cstarab_gt_50 | 4959 (0.41%) | 0.1704 | 0.3276 | 0.4022 | 0.5532 |
| Kodak Portra 160 | phone_p1025 | shadows_Lstar_lt_20 | 366588 (30.58%) | 0.3765 | 0.7660 | 1.0260 | 1.4612 |
| Kodak Portra 160 | phone_p1025 | highlights_Lstar_gt_85 | 788 (0.07%) | 0.2851 | 0.6046 | 0.7024 | 0.7432 |
| Kodak Portra 160 | phone_p1025 | saturated_Cstarab_gt_50 | 563 (0.05%) | 0.1712 | 0.3276 | 0.4146 | 0.4535 |
| Kodak Portra 160 | phone_p1043 | shadows_Lstar_lt_20 | 529626 (44.18%) | 0.3093 | 0.7024 | 0.9000 | 1.4612 |
| Kodak Portra 160 | phone_p1043 | highlights_Lstar_gt_85 | 2857 (0.24%) | 0.2827 | 0.5772 | 0.6884 | 0.9082 |
| Kodak Portra 160 | phone_p1043 | saturated_Cstarab_gt_50 | 29440 (2.46%) | 0.1701 | 0.3425 | 0.4246 | 0.5532 |
| Kodak Portra 160 | phone_p1062 | shadows_Lstar_lt_20 | 89642 (7.48%) | 0.3298 | 0.6647 | 0.8813 | 1.4755 |
| Kodak Portra 160 | phone_p1062 | highlights_Lstar_gt_85 | 41189 (3.44%) | 0.2118 | 0.4618 | 0.6688 | 0.6988 |
| Kodak Portra 160 | phone_p1062 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Portra 160 | phone_p237 | shadows_Lstar_lt_20 | 553204 (46.14%) | 0.2640 | 0.5659 | 0.8825 | 1.4612 |
| Kodak Portra 160 | phone_p237 | highlights_Lstar_gt_85 | 101 (0.01%) | 0.3443 | 0.6884 | 0.7585 | 0.7585 |
| Kodak Portra 160 | phone_p237 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Portra 160 | phone_p433 | shadows_Lstar_lt_20 | 217742 (18.16%) | 0.4458 | 0.7991 | 1.0532 | 1.4277 |
| Kodak Portra 160 | phone_p433 | highlights_Lstar_gt_85 | 69269 (5.78%) | 0.3072 | 0.6046 | 0.6637 | 0.9210 |
| Kodak Portra 160 | phone_p433 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Portra 160 | portrait | shadows_Lstar_lt_20 | 641411 (96.16%) | 0.3047 | 0.6500 | 0.9171 | 1.3998 |
| Kodak Portra 160 | portrait | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Portra 160 | portrait | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Portra 160 | chart | shadows_Lstar_lt_20 | 15314 (11.01%) | 0.3093 | 0.6653 | 0.9174 | 1.3286 |
| Kodak Portra 160 | chart | highlights_Lstar_gt_85 | 70863 (50.96%) | 0.2531 | 0.2526 | 0.3969 | 0.8259 |
| Kodak Portra 160 | chart | saturated_Cstarab_gt_50 | 5557 (4.00%) | 0.1499 | 0.2819 | 0.3274 | 0.4232 |
| Kodak Portra 160 | synthetic | shadows_Lstar_lt_20 | 29464 (7.49%) | 0.3485 | 1.0613 | 1.0822 | 1.0822 |
| Kodak Portra 160 | synthetic | highlights_Lstar_gt_85 | 2110 (0.54%) | 0.2579 | 0.4143 | 0.4338 | 0.4338 |
| Kodak Portra 160 | synthetic | saturated_Cstarab_gt_50 | 108348 (27.55%) | 0.1401 | 0.2573 | 0.3235 | 0.4625 |
| Kodak Gold 200 | phone_p1015 | shadows_Lstar_lt_20 | 107990 (9.01%) | 0.2459 | 0.5576 | 0.7883 | 1.3749 |
| Kodak Gold 200 | phone_p1015 | highlights_Lstar_gt_85 | 12918 (1.08%) | 0.2866 | 0.6149 | 0.7842 | 1.0385 |
| Kodak Gold 200 | phone_p1015 | saturated_Cstarab_gt_50 | 8767 (0.73%) | 0.1696 | 0.3292 | 0.4052 | 0.5520 |
| Kodak Gold 200 | phone_p1025 | shadows_Lstar_lt_20 | 447910 (37.36%) | 0.3151 | 0.6969 | 0.9303 | 1.3742 |
| Kodak Gold 200 | phone_p1025 | highlights_Lstar_gt_85 | 4258 (0.36%) | 0.3385 | 0.7390 | 0.7842 | 0.9821 |
| Kodak Gold 200 | phone_p1025 | saturated_Cstarab_gt_50 | 1599 (0.13%) | 0.1679 | 0.3195 | 0.3765 | 0.5898 |
| Kodak Gold 200 | phone_p1043 | shadows_Lstar_lt_20 | 568918 (47.46%) | 0.3246 | 0.6682 | 0.8953 | 1.3824 |
| Kodak Gold 200 | phone_p1043 | highlights_Lstar_gt_85 | 5315 (0.44%) | 0.2921 | 0.6044 | 0.7512 | 1.0048 |
| Kodak Gold 200 | phone_p1043 | saturated_Cstarab_gt_50 | 38455 (3.21%) | 0.1696 | 0.3330 | 0.4103 | 0.5703 |
| Kodak Gold 200 | phone_p1062 | shadows_Lstar_lt_20 | 113734 (9.49%) | 0.3444 | 0.7321 | 0.9258 | 1.3124 |
| Kodak Gold 200 | phone_p1062 | highlights_Lstar_gt_85 | 74957 (6.25%) | 0.2519 | 0.5316 | 0.6387 | 0.8223 |
| Kodak Gold 200 | phone_p1062 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Gold 200 | phone_p237 | shadows_Lstar_lt_20 | 576243 (48.07%) | 0.3336 | 0.5645 | 0.8327 | 1.3742 |
| Kodak Gold 200 | phone_p237 | highlights_Lstar_gt_85 | 155 (0.01%) | 0.2862 | 0.5880 | 0.8893 | 0.9821 |
| Kodak Gold 200 | phone_p237 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Gold 200 | phone_p433 | shadows_Lstar_lt_20 | 277545 (23.15%) | 0.4530 | 0.8674 | 1.0869 | 1.3742 |
| Kodak Gold 200 | phone_p433 | highlights_Lstar_gt_85 | 99332 (8.29%) | 0.3183 | 0.6384 | 0.7842 | 1.0869 |
| Kodak Gold 200 | phone_p433 | saturated_Cstarab_gt_50 | 20 (0.00%) | 0.2003 | 0.4433 | 0.5389 | 0.5628 |
| Kodak Gold 200 | portrait | shadows_Lstar_lt_20 | 644709 (96.66%) | 0.2945 | 0.5278 | 0.6726 | 1.3549 |
| Kodak Gold 200 | portrait | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Gold 200 | portrait | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Gold 200 | chart | shadows_Lstar_lt_20 | 15949 (11.47%) | 0.3080 | 0.6966 | 0.8554 | 1.1353 |
| Kodak Gold 200 | chart | highlights_Lstar_gt_85 | 71887 (51.70%) | 0.4051 | 0.4115 | 0.5316 | 0.8893 |
| Kodak Gold 200 | chart | saturated_Cstarab_gt_50 | 7193 (5.17%) | 0.1526 | 0.2928 | 0.3602 | 0.4939 |
| Kodak Gold 200 | synthetic | shadows_Lstar_lt_20 | 40046 (10.18%) | 0.2999 | 0.6966 | 0.9988 | 1.0361 |
| Kodak Gold 200 | synthetic | highlights_Lstar_gt_85 | 3315 (0.84%) | 0.2692 | 0.5120 | 0.6387 | 0.6387 |
| Kodak Gold 200 | synthetic | saturated_Cstarab_gt_50 | 144955 (36.86%) | 0.1380 | 0.2695 | 0.3203 | 0.4552 |
| Kodak Ultramax 400 | phone_p1015 | shadows_Lstar_lt_20 | 111010 (9.26%) | 0.2362 | 0.5521 | 0.7755 | 1.3362 |
| Kodak Ultramax 400 | phone_p1015 | highlights_Lstar_gt_85 | 7158 (0.60%) | 0.2921 | 0.5779 | 0.7430 | 1.1066 |
| Kodak Ultramax 400 | phone_p1015 | saturated_Cstarab_gt_50 | 8179 (0.68%) | 0.1756 | 0.3506 | 0.4373 | 0.5886 |
| Kodak Ultramax 400 | phone_p1025 | shadows_Lstar_lt_20 | 422730 (35.26%) | 0.3387 | 0.6889 | 0.9101 | 1.3618 |
| Kodak Ultramax 400 | phone_p1025 | highlights_Lstar_gt_85 | 1035 (0.09%) | 0.2958 | 0.5205 | 0.6627 | 0.8928 |
| Kodak Ultramax 400 | phone_p1025 | saturated_Cstarab_gt_50 | 1859 (0.16%) | 0.1909 | 0.3673 | 0.4286 | 0.5326 |
| Kodak Ultramax 400 | phone_p1043 | shadows_Lstar_lt_20 | 553377 (46.16%) | 0.3253 | 0.6772 | 0.9023 | 1.4018 |
| Kodak Ultramax 400 | phone_p1043 | highlights_Lstar_gt_85 | 2547 (0.21%) | 0.3030 | 0.5860 | 0.6965 | 0.9656 |
| Kodak Ultramax 400 | phone_p1043 | saturated_Cstarab_gt_50 | 38480 (3.21%) | 0.1705 | 0.3386 | 0.4254 | 0.5790 |
| Kodak Ultramax 400 | phone_p1062 | shadows_Lstar_lt_20 | 105124 (8.77%) | 0.3319 | 0.6555 | 0.8926 | 1.3362 |
| Kodak Ultramax 400 | phone_p1062 | highlights_Lstar_gt_85 | 41792 (3.49%) | 0.3077 | 0.4961 | 0.6132 | 0.6537 |
| Kodak Ultramax 400 | phone_p1062 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Ultramax 400 | phone_p237 | shadows_Lstar_lt_20 | 567831 (47.36%) | 0.3360 | 0.5226 | 0.7578 | 1.3618 |
| Kodak Ultramax 400 | phone_p237 | highlights_Lstar_gt_85 | 104 (0.01%) | 0.2947 | 0.7184 | 0.8145 | 0.8185 |
| Kodak Ultramax 400 | phone_p237 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Ultramax 400 | phone_p433 | shadows_Lstar_lt_20 | 267092 (22.28%) | 0.4163 | 0.8295 | 1.0662 | 1.4018 |
| Kodak Ultramax 400 | phone_p433 | highlights_Lstar_gt_85 | 73572 (6.14%) | 0.2952 | 0.6020 | 0.6480 | 0.9656 |
| Kodak Ultramax 400 | phone_p433 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Ultramax 400 | portrait | shadows_Lstar_lt_20 | 644342 (96.60%) | 0.2847 | 0.5963 | 0.7120 | 1.1943 |
| Kodak Ultramax 400 | portrait | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Ultramax 400 | portrait | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Ultramax 400 | chart | shadows_Lstar_lt_20 | 16434 (11.82%) | 0.3197 | 0.6728 | 0.9329 | 1.1568 |
| Kodak Ultramax 400 | chart | highlights_Lstar_gt_85 | 70864 (50.96%) | 0.3279 | 0.3318 | 0.3843 | 0.9089 |
| Kodak Ultramax 400 | chart | saturated_Cstarab_gt_50 | 7228 (5.20%) | 0.1421 | 0.2730 | 0.3540 | 0.5033 |
| Kodak Ultramax 400 | synthetic | shadows_Lstar_lt_20 | 40270 (10.24%) | 0.3032 | 0.7319 | 0.8000 | 0.8000 |
| Kodak Ultramax 400 | synthetic | highlights_Lstar_gt_85 | 2110 (0.54%) | 0.2898 | 0.4747 | 0.4747 | 0.6480 |
| Kodak Ultramax 400 | synthetic | saturated_Cstarab_gt_50 | 156344 (39.76%) | 0.1364 | 0.2621 | 0.3295 | 0.4573 |
| Kodak Ektar 100 | phone_p1015 | shadows_Lstar_lt_20 | 81737 (6.82%) | 0.2697 | 0.5908 | 0.8251 | 1.4753 |
| Kodak Ektar 100 | phone_p1015 | highlights_Lstar_gt_85 | 198140 (16.53%) | 0.2637 | 0.5730 | 0.7456 | 1.0361 |
| Kodak Ektar 100 | phone_p1015 | saturated_Cstarab_gt_50 | 18066 (1.51%) | 0.1656 | 0.3170 | 0.3935 | 0.5400 |
| Kodak Ektar 100 | phone_p1025 | shadows_Lstar_lt_20 | 560793 (46.78%) | 0.3415 | 0.7355 | 1.0200 | 1.4753 |
| Kodak Ektar 100 | phone_p1025 | highlights_Lstar_gt_85 | 74762 (6.24%) | 0.3305 | 0.6446 | 0.8321 | 0.9985 |
| Kodak Ektar 100 | phone_p1025 | saturated_Cstarab_gt_50 | 8170 (0.68%) | 0.1896 | 0.3527 | 0.4235 | 0.5804 |
| Kodak Ektar 100 | phone_p1043 | shadows_Lstar_lt_20 | 644876 (53.79%) | 0.2506 | 0.5159 | 0.6939 | 1.4142 |
| Kodak Ektar 100 | phone_p1043 | highlights_Lstar_gt_85 | 59314 (4.95%) | 0.2599 | 0.5698 | 0.6954 | 0.9275 |
| Kodak Ektar 100 | phone_p1043 | saturated_Cstarab_gt_50 | 72421 (6.04%) | 0.1725 | 0.3354 | 0.4084 | 0.6771 |
| Kodak Ektar 100 | phone_p1062 | shadows_Lstar_lt_20 | 171170 (14.28%) | 0.2744 | 0.5258 | 0.6616 | 0.9202 |
| Kodak Ektar 100 | phone_p1062 | highlights_Lstar_gt_85 | 259352 (21.63%) | 0.2737 | 0.5674 | 0.7505 | 0.9789 |
| Kodak Ektar 100 | phone_p1062 | saturated_Cstarab_gt_50 | 7 (0.00%) | 0.1520 | 0.2221 | 0.2409 | 0.2456 |
| Kodak Ektar 100 | phone_p237 | shadows_Lstar_lt_20 | 634393 (52.92%) | 0.2242 | 0.4332 | 0.5908 | 1.0648 |
| Kodak Ektar 100 | phone_p237 | highlights_Lstar_gt_85 | 11057 (0.92%) | 0.3144 | 0.6142 | 0.7235 | 0.9326 |
| Kodak Ektar 100 | phone_p237 | saturated_Cstarab_gt_50 | 22 (0.00%) | 0.1966 | 0.3874 | 0.4297 | 0.4405 |
| Kodak Ektar 100 | phone_p433 | shadows_Lstar_lt_20 | 333719 (27.84%) | 0.4255 | 0.7648 | 0.9192 | 1.2993 |
| Kodak Ektar 100 | phone_p433 | highlights_Lstar_gt_85 | 325239 (27.13%) | 0.3290 | 0.6864 | 0.8308 | 1.0543 |
| Kodak Ektar 100 | phone_p433 | saturated_Cstarab_gt_50 | 3962 (0.33%) | 0.1877 | 0.3523 | 0.4367 | 0.5321 |
| Kodak Ektar 100 | portrait | shadows_Lstar_lt_20 | 646154 (96.87%) | 0.2062 | 0.4627 | 0.6523 | 1.3251 |
| Kodak Ektar 100 | portrait | highlights_Lstar_gt_85 | 2839 (0.43%) | 0.2150 | 0.3771 | 0.5019 | 0.6675 |
| Kodak Ektar 100 | portrait | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Ektar 100 | chart | shadows_Lstar_lt_20 | 16966 (12.20%) | 0.3011 | 0.7115 | 1.0100 | 1.2101 |
| Kodak Ektar 100 | chart | highlights_Lstar_gt_85 | 78249 (56.27%) | 0.2382 | 0.2996 | 0.4979 | 0.9891 |
| Kodak Ektar 100 | chart | saturated_Cstarab_gt_50 | 9246 (6.65%) | 0.1440 | 0.2727 | 0.3512 | 0.5065 |
| Kodak Ektar 100 | synthetic | shadows_Lstar_lt_20 | 57028 (14.50%) | 0.2834 | 0.6474 | 0.9987 | 0.9987 |
| Kodak Ektar 100 | synthetic | highlights_Lstar_gt_85 | 14104 (3.59%) | 0.2878 | 0.6238 | 0.9891 | 0.9891 |
| Kodak Ektar 100 | synthetic | saturated_Cstarab_gt_50 | 116641 (29.66%) | 0.1431 | 0.2795 | 0.3826 | 0.5306 |
| Fujifilm Velvia 100 | phone_p1015 | shadows_Lstar_lt_20 | 149940 (12.51%) | 0.2427 | 0.6185 | 0.8560 | 1.6896 |
| Fujifilm Velvia 100 | phone_p1015 | highlights_Lstar_gt_85 | 93809 (7.82%) | 0.2940 | 0.6113 | 0.7870 | 1.2394 |
| Fujifilm Velvia 100 | phone_p1015 | saturated_Cstarab_gt_50 | 66399 (5.54%) | 0.1907 | 0.5513 | 0.7198 | 0.8590 |
| Fujifilm Velvia 100 | phone_p1025 | shadows_Lstar_lt_20 | 365088 (30.45%) | 0.4120 | 0.8351 | 1.0733 | 1.5468 |
| Fujifilm Velvia 100 | phone_p1025 | highlights_Lstar_gt_85 | 53460 (4.46%) | 0.3338 | 0.6823 | 0.8502 | 1.0983 |
| Fujifilm Velvia 100 | phone_p1025 | saturated_Cstarab_gt_50 | 10403 (0.87%) | 0.1535 | 0.2846 | 0.3351 | 0.4921 |
| Fujifilm Velvia 100 | phone_p1043 | shadows_Lstar_lt_20 | 519729 (43.35%) | 0.3668 | 0.7784 | 1.0636 | 1.6896 |
| Fujifilm Velvia 100 | phone_p1043 | highlights_Lstar_gt_85 | 24082 (2.01%) | 0.3355 | 0.7270 | 0.8769 | 1.1476 |
| Fujifilm Velvia 100 | phone_p1043 | saturated_Cstarab_gt_50 | 58565 (4.89%) | 0.1565 | 0.3058 | 0.3822 | 0.5745 |
| Fujifilm Velvia 100 | phone_p1062 | shadows_Lstar_lt_20 | 106324 (8.87%) | 0.3121 | 0.5823 | 0.6983 | 1.0765 |
| Fujifilm Velvia 100 | phone_p1062 | highlights_Lstar_gt_85 | 175025 (14.60%) | 0.3536 | 0.6710 | 0.8816 | 1.0983 |
| Fujifilm Velvia 100 | phone_p1062 | saturated_Cstarab_gt_50 | 6 (0.00%) | 0.1982 | 0.3841 | 0.4293 | 0.4405 |
| Fujifilm Velvia 100 | phone_p237 | shadows_Lstar_lt_20 | 560048 (46.72%) | 0.3032 | 0.5731 | 0.8129 | 1.5221 |
| Fujifilm Velvia 100 | phone_p237 | highlights_Lstar_gt_85 | 12073 (1.01%) | 0.3209 | 0.6871 | 0.8509 | 1.0119 |
| Fujifilm Velvia 100 | phone_p237 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Fujifilm Velvia 100 | phone_p433 | shadows_Lstar_lt_20 | 259192 (21.62%) | 0.5449 | 1.0755 | 1.3584 | 1.5221 |
| Fujifilm Velvia 100 | phone_p433 | highlights_Lstar_gt_85 | 305796 (25.51%) | 0.3394 | 0.6759 | 0.8502 | 1.2394 |
| Fujifilm Velvia 100 | phone_p433 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Fujifilm Velvia 100 | portrait | shadows_Lstar_lt_20 | 643764 (96.52%) | 0.3006 | 0.6343 | 0.8962 | 1.5221 |
| Fujifilm Velvia 100 | portrait | highlights_Lstar_gt_85 | 639 (0.10%) | 0.2923 | 0.8769 | 0.8769 | 0.8769 |
| Fujifilm Velvia 100 | portrait | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Fujifilm Velvia 100 | chart | shadows_Lstar_lt_20 | 16702 (12.01%) | 0.2778 | 0.6865 | 0.8368 | 1.3219 |
| Fujifilm Velvia 100 | chart | highlights_Lstar_gt_85 | 77429 (55.68%) | 0.6237 | 0.6662 | 0.7085 | 1.1668 |
| Fujifilm Velvia 100 | chart | saturated_Cstarab_gt_50 | 10181 (7.32%) | 0.1462 | 0.2826 | 0.3554 | 0.5589 |
| Fujifilm Velvia 100 | synthetic | shadows_Lstar_lt_20 | 58474 (14.87%) | 0.2725 | 0.7920 | 0.8523 | 1.3219 |
| Fujifilm Velvia 100 | synthetic | highlights_Lstar_gt_85 | 9739 (2.48%) | 0.3161 | 0.6052 | 0.6683 | 0.6988 |
| Fujifilm Velvia 100 | synthetic | saturated_Cstarab_gt_50 | 201284 (51.19%) | 0.1286 | 0.2628 | 0.4033 | 0.7033 |
| Fujifilm Provia 100F | phone_p1015 | shadows_Lstar_lt_20 | 165571 (13.81%) | 0.2163 | 0.4729 | 0.6910 | 1.4601 |
| Fujifilm Provia 100F | phone_p1015 | highlights_Lstar_gt_85 | 32509 (2.71%) | 0.3136 | 0.6250 | 0.7737 | 1.1562 |
| Fujifilm Provia 100F | phone_p1015 | saturated_Cstarab_gt_50 | 2392 (0.20%) | 0.1646 | 0.3223 | 0.4089 | 0.5333 |
| Fujifilm Provia 100F | phone_p1025 | shadows_Lstar_lt_20 | 305391 (25.47%) | 0.3550 | 0.7438 | 0.9803 | 1.4601 |
| Fujifilm Provia 100F | phone_p1025 | highlights_Lstar_gt_85 | 21113 (1.76%) | 0.3244 | 0.6287 | 0.8538 | 1.0358 |
| Fujifilm Provia 100F | phone_p1025 | saturated_Cstarab_gt_50 | 311 (0.03%) | 0.1482 | 0.2774 | 0.3472 | 0.4286 |
| Fujifilm Provia 100F | phone_p1043 | shadows_Lstar_lt_20 | 475772 (39.69%) | 0.3141 | 0.6529 | 0.8785 | 1.4601 |
| Fujifilm Provia 100F | phone_p1043 | highlights_Lstar_gt_85 | 10265 (0.86%) | 0.3339 | 0.6382 | 0.8086 | 0.9972 |
| Fujifilm Provia 100F | phone_p1043 | saturated_Cstarab_gt_50 | 20140 (1.68%) | 0.1501 | 0.2870 | 0.3566 | 0.4918 |
| Fujifilm Provia 100F | phone_p1062 | shadows_Lstar_lt_20 | 74917 (6.25%) | 0.2842 | 0.5502 | 0.6484 | 1.0743 |
| Fujifilm Provia 100F | phone_p1062 | highlights_Lstar_gt_85 | 109839 (9.16%) | 0.3563 | 0.5999 | 0.9401 | 0.9493 |
| Fujifilm Provia 100F | phone_p1062 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Fujifilm Provia 100F | phone_p237 | shadows_Lstar_lt_20 | 533448 (44.50%) | 0.2968 | 0.5082 | 0.7066 | 1.3308 |
| Fujifilm Provia 100F | phone_p237 | highlights_Lstar_gt_85 | 2282 (0.19%) | 0.2868 | 0.5804 | 0.7557 | 0.9851 |
| Fujifilm Provia 100F | phone_p237 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Fujifilm Provia 100F | phone_p433 | shadows_Lstar_lt_20 | 199068 (16.60%) | 0.3075 | 0.6311 | 0.9004 | 1.4601 |
| Fujifilm Provia 100F | phone_p433 | highlights_Lstar_gt_85 | 202418 (16.88%) | 0.3398 | 0.6641 | 0.7640 | 1.1562 |
| Fujifilm Provia 100F | phone_p433 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Fujifilm Provia 100F | portrait | shadows_Lstar_lt_20 | 636443 (95.42%) | 0.3079 | 0.6339 | 0.7964 | 1.4601 |
| Fujifilm Provia 100F | portrait | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Fujifilm Provia 100F | portrait | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Fujifilm Provia 100F | chart | shadows_Lstar_lt_20 | 14635 (10.52%) | 0.2971 | 0.6249 | 0.8717 | 1.2836 |
| Fujifilm Provia 100F | chart | highlights_Lstar_gt_85 | 74669 (53.70%) | 0.7088 | 0.7472 | 0.7472 | 1.1562 |
| Fujifilm Provia 100F | chart | saturated_Cstarab_gt_50 | 3835 (2.76%) | 0.1458 | 0.2838 | 0.3291 | 0.4117 |
| Fujifilm Provia 100F | synthetic | shadows_Lstar_lt_20 | 56889 (14.47%) | 0.2654 | 0.6581 | 0.6784 | 0.7186 |
| Fujifilm Provia 100F | synthetic | highlights_Lstar_gt_85 | 5710 (1.45%) | 0.3322 | 0.5801 | 0.6641 | 0.7472 |
| Fujifilm Provia 100F | synthetic | saturated_Cstarab_gt_50 | 125083 (31.81%) | 0.1323 | 0.2518 | 0.3009 | 0.4384 |
| Kodak Kodachrome 64 | phone_p1015 | shadows_Lstar_lt_20 | 110438 (9.21%) | 0.2309 | 0.5364 | 0.7660 | 1.3954 |
| Kodak Kodachrome 64 | phone_p1015 | highlights_Lstar_gt_85 | 2840 (0.24%) | 0.3194 | 0.6319 | 0.8177 | 0.9666 |
| Kodak Kodachrome 64 | phone_p1015 | saturated_Cstarab_gt_50 | 2812 (0.23%) | 0.1829 | 0.3546 | 0.4461 | 0.5661 |
| Kodak Kodachrome 64 | phone_p1025 | shadows_Lstar_lt_20 | 302868 (25.26%) | 0.3582 | 0.7493 | 0.9679 | 1.3954 |
| Kodak Kodachrome 64 | phone_p1025 | highlights_Lstar_gt_85 | 50 (0.00%) | 0.3402 | 0.7462 | 0.8036 | 0.8192 |
| Kodak Kodachrome 64 | phone_p1025 | saturated_Cstarab_gt_50 | 1585 (0.13%) | 0.1756 | 0.2639 | 0.3054 | 0.3632 |
| Kodak Kodachrome 64 | phone_p1043 | shadows_Lstar_lt_20 | 494516 (41.25%) | 0.3102 | 0.6412 | 0.8231 | 1.3954 |
| Kodak Kodachrome 64 | phone_p1043 | highlights_Lstar_gt_85 | 601 (0.05%) | 0.2789 | 0.5618 | 0.7027 | 0.9394 |
| Kodak Kodachrome 64 | phone_p1043 | saturated_Cstarab_gt_50 | 23672 (1.97%) | 0.1778 | 0.3586 | 0.4359 | 0.5100 |
| Kodak Kodachrome 64 | phone_p1062 | shadows_Lstar_lt_20 | 92842 (7.74%) | 0.2862 | 0.5678 | 0.6790 | 1.0131 |
| Kodak Kodachrome 64 | phone_p1062 | highlights_Lstar_gt_85 | 9167 (0.76%) | 0.3230 | 0.5798 | 0.7291 | 0.8177 |
| Kodak Kodachrome 64 | phone_p1062 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Kodachrome 64 | phone_p237 | shadows_Lstar_lt_20 | 548123 (45.72%) | 0.2515 | 0.5582 | 0.7645 | 1.1535 |
| Kodak Kodachrome 64 | phone_p237 | highlights_Lstar_gt_85 | 64 (0.01%) | 0.2889 | 0.5548 | 0.6492 | 0.7011 |
| Kodak Kodachrome 64 | phone_p237 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Kodachrome 64 | phone_p433 | shadows_Lstar_lt_20 | 206624 (17.24%) | 0.4676 | 0.8844 | 1.0826 | 1.2666 |
| Kodak Kodachrome 64 | phone_p433 | highlights_Lstar_gt_85 | 38636 (3.22%) | 0.3499 | 0.7291 | 0.8052 | 0.9363 |
| Kodak Kodachrome 64 | phone_p433 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Kodachrome 64 | portrait | shadows_Lstar_lt_20 | 639559 (95.89%) | 0.2880 | 0.5750 | 0.7549 | 1.3172 |
| Kodak Kodachrome 64 | portrait | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Kodachrome 64 | portrait | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Kodachrome 64 | chart | shadows_Lstar_lt_20 | 14756 (10.61%) | 0.2819 | 0.6034 | 0.7813 | 1.3173 |
| Kodak Kodachrome 64 | chart | highlights_Lstar_gt_85 | 70205 (50.49%) | 0.2007 | 0.1976 | 0.4113 | 0.9666 |
| Kodak Kodachrome 64 | chart | saturated_Cstarab_gt_50 | 4825 (3.47%) | 0.1375 | 0.2611 | 0.3237 | 0.4659 |
| Kodak Kodachrome 64 | synthetic | shadows_Lstar_lt_20 | 44553 (11.33%) | 0.2769 | 0.6890 | 0.6915 | 0.7332 |
| Kodak Kodachrome 64 | synthetic | highlights_Lstar_gt_85 | 513 (0.13%) | 0.3286 | 0.6133 | 0.6187 | 0.6187 |
| Kodak Kodachrome 64 | synthetic | saturated_Cstarab_gt_50 | 129857 (33.02%) | 0.1331 | 0.2654 | 0.3236 | 0.4810 |
| Fujifilm Pro 400H | phone_p1015 | shadows_Lstar_lt_20 | 137933 (11.51%) | 0.2072 | 0.5219 | 0.7563 | 1.5538 |
| Fujifilm Pro 400H | phone_p1015 | highlights_Lstar_gt_85 | 8472 (0.71%) | 0.2926 | 0.6154 | 0.7653 | 0.9233 |
| Fujifilm Pro 400H | phone_p1015 | saturated_Cstarab_gt_50 | 23711 (1.98%) | 0.1377 | 0.2790 | 0.3742 | 0.5522 |
| Fujifilm Pro 400H | phone_p1025 | shadows_Lstar_lt_20 | 398485 (33.24%) | 0.3340 | 0.6960 | 0.9338 | 1.5538 |
| Fujifilm Pro 400H | phone_p1025 | highlights_Lstar_gt_85 | 1174 (0.10%) | 0.2682 | 0.6300 | 0.7326 | 0.8009 |
| Fujifilm Pro 400H | phone_p1025 | saturated_Cstarab_gt_50 | 4628 (0.39%) | 0.1724 | 0.3279 | 0.3929 | 0.5305 |
| Fujifilm Pro 400H | phone_p1043 | shadows_Lstar_lt_20 | 544529 (45.42%) | 0.3010 | 0.6872 | 0.9522 | 1.5538 |
| Fujifilm Pro 400H | phone_p1043 | highlights_Lstar_gt_85 | 2362 (0.20%) | 0.3397 | 0.7659 | 0.8963 | 0.9817 |
| Fujifilm Pro 400H | phone_p1043 | saturated_Cstarab_gt_50 | 45134 (3.76%) | 0.1642 | 0.3309 | 0.4097 | 0.5733 |
| Fujifilm Pro 400H | phone_p1062 | shadows_Lstar_lt_20 | 115679 (9.65%) | 0.3214 | 0.6520 | 0.8121 | 1.5538 |
| Fujifilm Pro 400H | phone_p1062 | highlights_Lstar_gt_85 | 41384 (3.45%) | 0.2969 | 0.5735 | 0.7877 | 0.7877 |
| Fujifilm Pro 400H | phone_p1062 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Fujifilm Pro 400H | phone_p237 | shadows_Lstar_lt_20 | 572776 (47.78%) | 0.2460 | 0.5515 | 0.7977 | 1.5538 |
| Fujifilm Pro 400H | phone_p237 | highlights_Lstar_gt_85 | 105 (0.01%) | 0.3203 | 0.6274 | 0.8022 | 0.8620 |
| Fujifilm Pro 400H | phone_p237 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Fujifilm Pro 400H | phone_p433 | shadows_Lstar_lt_20 | 273783 (22.84%) | 0.3890 | 0.8508 | 1.0748 | 1.5538 |
| Fujifilm Pro 400H | phone_p433 | highlights_Lstar_gt_85 | 77737 (6.48%) | 0.2653 | 0.5922 | 0.7877 | 0.9508 |
| Fujifilm Pro 400H | phone_p433 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Fujifilm Pro 400H | portrait | shadows_Lstar_lt_20 | 644392 (96.61%) | 0.2603 | 0.5786 | 0.7058 | 1.2926 |
| Fujifilm Pro 400H | portrait | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Fujifilm Pro 400H | portrait | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Fujifilm Pro 400H | chart | shadows_Lstar_lt_20 | 16971 (12.20%) | 0.2917 | 0.6235 | 0.8677 | 1.3517 |
| Fujifilm Pro 400H | chart | highlights_Lstar_gt_85 | 70864 (50.96%) | 0.5101 | 0.5168 | 0.6187 | 0.8943 |
| Fujifilm Pro 400H | chart | saturated_Cstarab_gt_50 | 7663 (5.51%) | 0.1383 | 0.2632 | 0.3438 | 0.4884 |
| Fujifilm Pro 400H | synthetic | shadows_Lstar_lt_20 | 58931 (14.99%) | 0.2490 | 0.6580 | 0.9262 | 0.9262 |
| Fujifilm Pro 400H | synthetic | highlights_Lstar_gt_85 | 2110 (0.54%) | 0.3058 | 0.5161 | 0.5556 | 0.5922 |
| Fujifilm Pro 400H | synthetic | saturated_Cstarab_gt_50 | 178631 (45.43%) | 0.1248 | 0.2395 | 0.3040 | 0.4317 |
| Kodak Vision3 250D | phone_p1015 | shadows_Lstar_lt_20 | 128319 (10.70%) | 0.2174 | 0.5060 | 0.7244 | 1.3459 |
| Kodak Vision3 250D | phone_p1015 | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 250D | phone_p1015 | saturated_Cstarab_gt_50 | 6219 (0.52%) | 0.1716 | 0.3383 | 0.4159 | 0.5497 |
| Kodak Vision3 250D | phone_p1025 | shadows_Lstar_lt_20 | 373138 (31.12%) | 0.3240 | 0.6637 | 0.8650 | 1.3547 |
| Kodak Vision3 250D | phone_p1025 | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 250D | phone_p1025 | saturated_Cstarab_gt_50 | 1686 (0.14%) | 0.1753 | 0.3254 | 0.3970 | 0.5101 |
| Kodak Vision3 250D | phone_p1043 | shadows_Lstar_lt_20 | 533165 (44.47%) | 0.2981 | 0.6565 | 0.8611 | 1.3547 |
| Kodak Vision3 250D | phone_p1043 | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 250D | phone_p1043 | saturated_Cstarab_gt_50 | 35093 (2.93%) | 0.1694 | 0.3311 | 0.4066 | 0.5519 |
| Kodak Vision3 250D | phone_p1062 | shadows_Lstar_lt_20 | 94732 (7.90%) | 0.3437 | 0.7813 | 1.0115 | 1.3055 |
| Kodak Vision3 250D | phone_p1062 | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 250D | phone_p1062 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 250D | phone_p237 | shadows_Lstar_lt_20 | 556721 (46.44%) | 0.2949 | 0.6152 | 0.8566 | 1.3547 |
| Kodak Vision3 250D | phone_p237 | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 250D | phone_p237 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 250D | phone_p433 | shadows_Lstar_lt_20 | 233717 (19.50%) | 0.3752 | 0.7645 | 0.9523 | 1.3547 |
| Kodak Vision3 250D | phone_p433 | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 250D | phone_p433 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 250D | portrait | shadows_Lstar_lt_20 | 642401 (96.31%) | 0.2727 | 0.5669 | 0.8378 | 1.2540 |
| Kodak Vision3 250D | portrait | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 250D | portrait | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 250D | chart | shadows_Lstar_lt_20 | 16546 (11.90%) | 0.2763 | 0.6575 | 0.7813 | 1.3547 |
| Kodak Vision3 250D | chart | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 250D | chart | saturated_Cstarab_gt_50 | 5600 (4.03%) | 0.1501 | 0.3001 | 0.3740 | 0.5126 |
| Kodak Vision3 250D | synthetic | shadows_Lstar_lt_20 | 45315 (11.52%) | 0.2408 | 0.6637 | 0.7544 | 0.7544 |
| Kodak Vision3 250D | synthetic | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 250D | synthetic | saturated_Cstarab_gt_50 | 120048 (30.53%) | 0.1459 | 0.3177 | 0.3880 | 0.4653 |
| Kodak Vision3 500T | phone_p1015 | shadows_Lstar_lt_20 | 123894 (10.33%) | 0.2138 | 0.5036 | 0.6957 | 1.4372 |
| Kodak Vision3 500T | phone_p1015 | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 500T | phone_p1015 | saturated_Cstarab_gt_50 | 4996 (0.42%) | 0.1754 | 0.3393 | 0.4303 | 0.5527 |
| Kodak Vision3 500T | phone_p1025 | shadows_Lstar_lt_20 | 378005 (31.53%) | 0.3341 | 0.6596 | 0.9369 | 1.4372 |
| Kodak Vision3 500T | phone_p1025 | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 500T | phone_p1025 | saturated_Cstarab_gt_50 | 1764 (0.15%) | 0.1783 | 0.3494 | 0.4166 | 0.5123 |
| Kodak Vision3 500T | phone_p1043 | shadows_Lstar_lt_20 | 544653 (45.43%) | 0.2955 | 0.6406 | 0.8590 | 1.4372 |
| Kodak Vision3 500T | phone_p1043 | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 500T | phone_p1043 | saturated_Cstarab_gt_50 | 33563 (2.80%) | 0.1706 | 0.3337 | 0.4159 | 0.5827 |
| Kodak Vision3 500T | phone_p1062 | shadows_Lstar_lt_20 | 99927 (8.34%) | 0.3703 | 0.7462 | 0.9341 | 1.2681 |
| Kodak Vision3 500T | phone_p1062 | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 500T | phone_p1062 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 500T | phone_p237 | shadows_Lstar_lt_20 | 562096 (46.89%) | 0.2810 | 0.6061 | 0.8798 | 1.4372 |
| Kodak Vision3 500T | phone_p237 | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 500T | phone_p237 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 500T | phone_p433 | shadows_Lstar_lt_20 | 231471 (19.31%) | 0.4318 | 0.9395 | 1.1263 | 1.4372 |
| Kodak Vision3 500T | phone_p433 | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 500T | phone_p433 | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 500T | portrait | shadows_Lstar_lt_20 | 642177 (96.28%) | 0.2834 | 0.6037 | 0.8305 | 1.2681 |
| Kodak Vision3 500T | portrait | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 500T | portrait | saturated_Cstarab_gt_50 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 500T | chart | shadows_Lstar_lt_20 | 16375 (11.78%) | 0.3071 | 0.6550 | 0.8019 | 1.1981 |
| Kodak Vision3 500T | chart | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 500T | chart | saturated_Cstarab_gt_50 | 5964 (4.29%) | 0.1494 | 0.2943 | 0.4121 | 0.5160 |
| Kodak Vision3 500T | synthetic | shadows_Lstar_lt_20 | 46518 (11.83%) | 0.2531 | 0.6452 | 0.7807 | 0.7807 |
| Kodak Vision3 500T | synthetic | highlights_Lstar_gt_85 | 0 (0.00%) | — | — | — | — |
| Kodak Vision3 500T | synthetic | saturated_Cstarab_gt_50 | 117011 (29.76%) | 0.1446 | 0.2920 | 0.4020 | 0.4520 |

## Neutral ramps (full physical / tiled LUT mean sRGB codes)

Each cell is `physical → LUT`. The spread column is for the LUT. Strict near-white
monotonicity compares inputs 230 < 250 < 255. A physical flat/non-monotonic response is
distinguished from an interpolation defect. `8-bit plateau` marks a non-decreasing LUT
plateau only where the full physical rise is below one output code and therefore cannot
remain strictly increasing after correct 8-bit rounding; it is reported, not retuned.

| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 250 | 255 | Max spread | LUT monotonic |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| Kodak Portra 400 | 3.0→3.3 | 4.2→4.3 | 16.4→17.0 | 31.7→31.7 | 59.5→59.0 | 115.7→116.0 | 177.1→177.3 | 199.0→198.7 | 211.0→211.3 | 215.4→215.3 | 216.3→216.3 | 5.0 | strict |
| Kodak Portra 160 | 3.0→3.0 | 4.4→4.7 | 18.1→18.3 | 33.9→34.0 | 60.6→60.3 | 115.9→116.0 | 178.4→178.3 | 199.5→199.3 | 210.8→211.0 | 215.1→215.0 | 216.0→216.0 | 8.0 | strict |
| Kodak Gold 200 | 2.7→2.7 | 3.2→3.7 | 9.8→10.3 | 22.0→22.3 | 50.1→50.3 | 116.0→115.7 | 177.0→176.7 | 198.3→198.0 | 210.5→211.0 | 215.2→215.0 | 216.1→216.3 | 8.0 | strict |
| Kodak Ultramax 400 | 2.7→2.7 | 3.3→3.7 | 11.2→12.0 | 24.5→25.0 | 53.0→53.0 | 116.0→116.0 | 175.3→175.0 | 196.7→196.3 | 209.4→209.7 | 214.4→214.3 | 215.4→215.3 | 7.0 | strict |
| Kodak Ektar 100 | 3.6→3.7 | 3.8→4.0 | 7.1→7.3 | 15.8→16.0 | 38.5→38.3 | 110.3→110.3 | 197.0→197.0 | 216.0→215.7 | 222.9→222.7 | 225.0→225.0 | 225.3→225.0 | 15.0 | 8-bit plateau |
| Fujifilm Velvia 100 | 3.3→3.3 | 3.4→3.7 | 9.0→9.7 | 25.0→25.3 | 56.3→56.0 | 116.6→116.7 | 187.6→187.7 | 208.6→208.3 | 217.9→218.0 | 221.0→220.7 | 221.5→221.7 | 4.0 | strict |
| Fujifilm Provia 100F | 2.8→2.7 | 3.9→4.3 | 19.2→19.3 | 37.3→37.3 | 64.6→64.3 | 116.0→116.3 | 180.7→180.3 | 203.3→203.0 | 214.8→215.3 | 218.8→218.7 | 219.5→219.7 | 3.0 | strict |
| Kodak Kodachrome 64 | 2.3→2.0 | 3.2→3.7 | 17.0→17.7 | 34.7→35.0 | 63.1→62.7 | 116.0→116.0 | 173.3→173.3 | 195.2→194.7 | 207.7→208.0 | 212.5→212.7 | 213.5→213.3 | 10.0 | strict |
| Fujifilm Pro 400H | 2.7→2.7 | 3.2→3.7 | 10.6→10.7 | 23.3→23.7 | 51.8→52.0 | 116.8→116.7 | 176.6→176.7 | 197.5→197.0 | 209.8→210.0 | 214.7→214.7 | 215.7→215.7 | 9.0 | strict |
| Kodak Vision3 250D | 2.4→2.3 | 3.1→3.3 | 12.2→12.7 | 28.7→29.0 | 58.9→59.0 | 115.2→115.0 | 167.3→167.3 | 186.8→186.7 | 199.6→199.7 | 205.0→205.0 | 206.2→206.0 | 14.0 | strict |
| Kodak Vision3 500T | 2.4→2.3 | 3.2→3.7 | 12.2→12.7 | 28.9→29.0 | 59.1→58.7 | 115.2→115.3 | 167.6→167.3 | 187.1→187.0 | 199.9→200.3 | 205.3→205.7 | 206.4→206.7 | 15.0 | strict |

## Cube edge handling (selected N)

Percentages are measured over all physical cube outputs before the LUT creator's
required [0,1] clamp. CAM16-UCS chroma/lightness compression is active inside the full
pipeline; any remaining floating-point excursions are clipped identically at the cube
and display-reference boundary. Linear-light excursions are also recorded in JSON.

| Stock | Nodes any encoded channel outside | Encoded samples outside | Encoded min/max |
|---|---:|---:|---:|
| Kodak Portra 400 | 0.000000% | 0.000000% | 0.009919/0.922164 |
| Kodak Portra 160 | 0.000000% | 0.000000% | 0.009761/0.919192 |
| Kodak Gold 200 | 0.000000% | 0.000000% | 0.008709/0.928319 |
| Kodak Ultramax 400 | 0.000000% | 0.000000% | 0.008663/0.923909 |
| Kodak Ektar 100 | 0.000000% | 0.000000% | 0.007337/0.982143 |
| Fujifilm Velvia 100 | 0.000000% | 0.000000% | 0.001345/0.929548 |
| Fujifilm Provia 100F | 0.000000% | 0.000000% | 0.006196/0.898571 |
| Kodak Kodachrome 64 | 0.000000% | 0.000000% | 0.004202/0.885861 |
| Fujifilm Pro 400H | 0.000000% | 0.000000% | 0.005576/0.920159 |
| Kodak Vision3 250D | 0.000000% | 0.000000% | 0.001865/0.872633 |
| Kodak Vision3 500T | 0.000000% | 0.000000% | 0.001828/0.872433 |

## Effective per-stock physical parameters

| Stock | Route | Camera EV | Print exposure / compensation | Scanner W/B | Neutral C/M/Y |
|---|---|---:|---|:---:|---:|
| Kodak Portra 400 | kodak_portra_endura | +0.000000 | 1.000 / on | on/on | 0/51.568/52.534 |
| Kodak Portra 160 | kodak_portra_endura | +0.000000 | 1.000 / on | on/on | 0/59.9674/53.2133 |
| Kodak Gold 200 | kodak_supra_endura | +0.000000 | 1.000 / on | on/on | 0/57.7149/58.5841 |
| Kodak Ultramax 400 | kodak_supra_endura | +0.000000 | 1.000 / on | on/on | 0/57.7771/62.2017 |
| Kodak Ektar 100 | kodak_ultra_endura | +0.000000 | 1.000 / on | on/on | 0/71.2174/55.5844 |
| Fujifilm Velvia 100 | direct positive scan | +0.000000 | 1.000 / on | on/on | 0/50/50 |
| Fujifilm Provia 100F | direct positive scan | +0.000000 | 1.000 / on | on/on | 0/50/50 |
| Kodak Kodachrome 64 | direct positive scan | +0.000000 | 1.000 / on | on/on | 0/50/50 |
| Fujifilm Pro 400H | fujifilm_crystal_archive_typeii | +0.000000 | 1.000 / on | on/on | 0/48.1537/50.7353 |
| Kodak Vision3 250D | kodak_2383 | +0.000000 | 1.000 / on | on/on | 0/50.7547/54.4769 |
| Kodak Vision3 500T | kodak_2383 | +0.000000 | 1.000 / on | on/on | 0/44.6135/56.7641 |
