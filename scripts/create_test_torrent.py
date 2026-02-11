#!/usr/bin/env python3
"""
Create a v1 .torrent file from a local video for E2E testing.
Pure Python — no external dependencies.

Usage:
    python3 scripts/create_test_torrent.py [input_file] [output_torrent]

Defaults:
    input_file:     downloads/bbb_sunflower_1080p_30fps_normal.mp4
    output_torrent: fixtures/local_test/bbb_sunflower.torrent
"""
import hashlib
import os
import sys

PIECE_LENGTH = 262144  # 256 KB
TRACKER = "ws://localhost:8000/announce"


def bencode(obj):
    """Bencode a Python object (int, bytes, str, list, dict)."""
    if isinstance(obj, int):
        return b"i" + str(obj).encode() + b"e"
    if isinstance(obj, bytes):
        return str(len(obj)).encode() + b":" + obj
    if isinstance(obj, str):
        return bencode(obj.encode("utf-8"))
    if isinstance(obj, list):
        return b"l" + b"".join(bencode(i) for i in obj) + b"e"
    if isinstance(obj, dict):
        items = sorted(obj.items(), key=lambda kv: kv[0] if isinstance(kv[0], bytes) else kv[0].encode())
        return b"d" + b"".join(bencode(k) + bencode(v) for k, v in items) + b"e"
    raise TypeError(f"Cannot bencode {type(obj)}")


def create_torrent(input_path, output_path):
    file_size = os.path.getsize(input_path)
    file_name = os.path.basename(input_path)

    print(f"Input:        {input_path}")
    print(f"File size:    {file_size:,} bytes ({file_size / 1024 / 1024:.1f} MB)")
    print(f"Piece length: {PIECE_LENGTH:,} bytes")

    # Compute SHA-1 piece hashes
    pieces = b""
    num_pieces = 0
    with open(input_path, "rb") as f:
        while True:
            chunk = f.read(PIECE_LENGTH)
            if not chunk:
                break
            pieces += hashlib.sha1(chunk).digest()
            num_pieces += 1
            if num_pieces % 100 == 0:
                print(f"  Hashed {num_pieces} pieces...", end="\r")

    print(f"Pieces:       {num_pieces}")

    # Build info dict
    info = {
        "name": file_name,
        "piece length": PIECE_LENGTH,
        "pieces": pieces,
        "length": file_size,
    }

    # Compute infohash
    info_bencoded = bencode(info)
    infohash = hashlib.sha1(info_bencoded).hexdigest()

    # Build torrent dict
    torrent = {
        "announce": TRACKER,
        "info": info,
    }

    # Write .torrent
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(bencode(torrent))

    print(f"Output:       {output_path}")
    print(f"Infohash:     {infohash}")
    print(f"Magnet:       magnet:?xt=urn:btih:{infohash}&dn={file_name}&tr={TRACKER}")


if __name__ == "__main__":
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(script_dir)

    input_file = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root_dir, "downloads", "bbb_sunflower_1080p_30fps_normal.mp4")
    output_file = sys.argv[2] if len(sys.argv) > 2 else os.path.join(root_dir, "fixtures", "local_test", "bbb_sunflower.torrent")

    if not os.path.exists(input_file):
        print(f"ERROR: Input file not found: {input_file}")
        sys.exit(1)

    create_torrent(input_file, output_file)
