"""Further networks for exp_cnn.py.

InceptionNet: InceptionTime (Ismail Fawaz et al. 2020) scaled to a 1 s window. Each module has a 1x1 bottleneck, three
parallel convolutions of different lengths (seeing short, middle and long spans at once), and a max-pool branch; modules
are stacked with a residual connection every three; the time axis is pooled (maximum and mean, as the trainer's network
does) into a small dense head.
"""
import torch
from torch import nn

from label_trainer import cnn


class InceptionModule(nn.Module):
    def __init__(self, c_in, filters, kernels, bottleneck=16):
        super().__init__()
        self.bottleneck = nn.Conv1d(c_in, bottleneck, 1, bias=False) if c_in > 1 else nn.Identity()
        b = bottleneck if c_in > 1 else c_in
        self.convs = nn.ModuleList([nn.Conv1d(b, filters, k, padding=k // 2, bias=False) for k in kernels])
        self.pool = nn.Sequential(nn.MaxPool1d(3, stride=1, padding=1), nn.Conv1d(c_in, filters, 1, bias=False))
        self.bn = nn.BatchNorm1d(filters * (len(kernels) + 1))

    def forward(self, x):
        z = self.bottleneck(x)
        return torch.relu(self.bn(torch.cat([c(z) for c in self.convs] + [self.pool(x)], 1)))


class InceptionNet(nn.Module):
    def __init__(self, channels, hz, filters=16, depth=6):
        super().__init__()
        kernels = (5, 11, 23) if hz == 100 else (3, 7, 13)
        width = filters * (len(kernels) + 1)
        self.modules_ = nn.ModuleList()
        self.shortcuts = nn.ModuleList()
        c, res_in = channels, channels
        for i in range(depth):
            self.modules_.append(InceptionModule(c, filters, kernels))
            c = width
            if i % 3 == 2:
                self.shortcuts.append(nn.Sequential(nn.Conv1d(res_in, width, 1, bias=False), nn.BatchNorm1d(width)))
                res_in = width
        self.head = nn.Sequential(nn.Linear(2 * width, cnn.HIDDEN), nn.ReLU(), nn.Dropout(0.2), nn.Linear(cnn.HIDDEN, 1))

    def forward(self, x):
        res, h, s = x, x, 0
        for i, m in enumerate(self.modules_):
            h = m(h)
            if i % 3 == 2:
                h = torch.relu(h + self.shortcuts[s](res))
                res, s = h, s + 1
        return self.head(torch.cat([h.amax(2), h.mean(2)], 1)).squeeze(1)
