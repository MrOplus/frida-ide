"""Map Android device ABIs to Frida release asset names."""

ABI_TO_FRIDA_ARCH: dict[str, str] = {
    "arm64-v8a": "android-arm64",
    "armeabi-v7a": "android-arm",
    "x86_64": "android-x86_64",
    "x86": "android-x86",
}


def frida_arch_for_abi(abi: str) -> str | None:
    return ABI_TO_FRIDA_ARCH.get(abi.strip())
