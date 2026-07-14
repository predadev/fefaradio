import wave
import math
import struct

sample_rate = 8000
duration = 5.0
n_samples = int(sample_rate * duration)

with wave.open('c:\\Users\\eliman04\\Desktop\\teste\\site radio\\public\\test.wav', 'w') as wav_file:
    wav_file.setnchannels(1)
    wav_file.setsampwidth(2)
    wav_file.setframerate(sample_rate)
    for i in range(n_samples):
        val = int(32767.0 * math.sin(2.0 * math.pi * 440.0 * i / sample_rate))
        wav_file.writeframes(struct.pack('<h', val))
