"""Captures what the computer is playing (WASAPI loopback on Windows, the monitor
source on Linux) as 24 kHz mono 16-bit PCM, in 20 ms chunks.

Raw PCM keeps this dependency-free on the browser side: about 48 kB/s, well
within a school connection, and the page plays it with the Web Audio API.
"""

from __future__ import annotations

import logging
import sys
import threading
import warnings
from typing import Callable

log = logging.getLogger("jarvis.audio")

RATE = 48_000
BLOCK = 960  # 20 ms at 48 kHz


class AudioCapture:
    def __init__(self, on_chunk: Callable[[bytes], None]):
        self.on_chunk = on_chunk
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.error = ""

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self) -> None:
        if self.running:
            if not self._stop.is_set():
                return
            self._thread.join(1)  # type: ignore[union-attr]  # a stop is in progress; let it finish
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="audio", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        try:
            # Import first: soundcard initialises COM itself on the thread that
            # imports it, and treats an already-initialised thread as an error.
            import numpy as np
            import soundcard as sc

            if sys.platform == "win32":
                import ctypes

                ctypes.windll.ole32.CoInitializeEx(None, 0)  # later threads still need COM; a repeat call is harmless

            warnings.filterwarnings("ignore", module="soundcard")
            speaker = sc.default_speaker()
            mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)
            log.info("capturing audio from %s", speaker.name)
            with mic.recorder(samplerate=RATE, channels=2, blocksize=BLOCK) as rec:
                while not self._stop.is_set():
                    data = rec.record(numframes=BLOCK)
                    mono = data.mean(axis=1) if data.ndim == 2 else data
                    half = mono[: len(mono) // 2 * 2].reshape(-1, 2).mean(axis=1)  # 48k -> 24k
                    pcm = (np.clip(half, -1.0, 1.0) * 32767).astype("<i2").tobytes()
                    self.on_chunk(pcm)
        except Exception as exc:  # noqa: BLE001 - audio is optional; video keeps working
            self.error = f"{exc.__class__.__name__}: {exc}"
            log.warning("audio capture stopped: %s", self.error)
