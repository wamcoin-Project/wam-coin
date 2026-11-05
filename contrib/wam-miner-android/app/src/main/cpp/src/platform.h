// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  platform.h -- everything in wam-miner that differs between operating
//                systems, in one file
// ===========================================================================
//
//  WHY THIS FILE EXISTS
//
//  wam-miner was written on Linux and compiled nowhere else. Of its 2600
//  lines, the parts that were not portable came to about forty: a TCP socket
//  in stratum.h, one call to localtime_r, and the assumption that writing an
//  ANSI escape to the terminal colours the text. The RandomX engine, the JSON
//  parser, sha256 and the rest of main.cpp are standard C++17 and cross-compile
//  with nothing changed.
//
//  That is worth more than a build convenience. RandomX was chosen for this
//  chain so an ordinary desktop can mine, and most ordinary desktops run
//  Windows. A release that ships a Windows node without a Windows miner hands
//  those people a wallet and tells them to install Linux before they can take
//  part in the proof of work -- excluding the exact audience the algorithm was
//  picked for, on account of forty lines.
//
//  Every #ifdef in the miner is here. stratum.h and main.cpp read the same on
//  both systems, because the stratum protocol and the mining loop do not
//  change between them. A shim added anywhere else is how a port rots.
//
//  WHAT WINSOCK ACTUALLY CHANGES
//
//  Six things, and two of them fail quietly:
//
//    1. the library has to be started (WSAStartup) before any call
//    2. a socket is an unsigned handle, so `fd < 0` is never true and every
//       "did that fail?" test written the POSIX way silently passes
//    3. close() is closesocket()
//    4. errors are in WSAGetLastError(), not errno, and strerror() knows
//       nothing about them -- it would answer "Unknown error"
//    5. SO_RCVTIMEO and SO_SNDTIMEO take milliseconds in a DWORD, not a
//       struct timeval
//    6. a receive timeout reports WSAETIMEDOUT where POSIX reports EAGAIN
//
//  Number 6 is the one that would have cost a night. stratum.h sets a
//  one-second receive timeout deliberately, so that the I/O loop always
//  returns and CheckSilence() gets to run. On Windows that timeout therefore
//  fires every single second of normal operation. Tested the POSIX way --
//  WSAETIMEDOUT is not EAGAIN -- the miner would tear down a healthy
//  connection once per second forever and report a read failure each time. It
//  would build, run, print errors, and mine nothing, and it would look like a
//  broken pool rather than a broken port.
//
//  Number 5 fails more quietly still. A timeval on x86-64 begins with the
//  seconds as a 64-bit integer, so Winsock reads the first four bytes of
//  "1 second" and sets a timeout of 1 millisecond: the loop spins at a
//  thousand turns a second instead of one, burning a core that should be
//  hashing.
// ===========================================================================

#pragma once

#ifdef _WIN32
// winsock2.h must precede windows.h, or windows.h pulls in the 1.1 headers
// and every symbol below is redefined.
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  include <windows.h>
#else
#  include <arpa/inet.h>
#  include <netdb.h>
#  include <netinet/in.h>
#  include <netinet/tcp.h>
#  include <sys/socket.h>
#  include <sys/types.h>
#  include <unistd.h>
#endif

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <string>

namespace wam {

// ---------------------------------------------------------------------------
//  Sockets
// ---------------------------------------------------------------------------

#ifdef _WIN32
using sock_t = SOCKET;
inline constexpr sock_t kInvalidSock = INVALID_SOCKET;
#else
using sock_t = int;
inline constexpr sock_t kInvalidSock = -1;
#endif

#ifdef MSG_NOSIGNAL
inline constexpr int kSendFlags = MSG_NOSIGNAL;
#else
// Windows has no SIGPIPE, so there is no signal to suppress. A constant
// rather than a #define of MSG_NOSIGNAL itself, because defining a system
// macro from our own header is how two headers come to disagree later.
inline constexpr int kSendFlags = 0;
#endif

/**
 * Start the socket library, once, and stop it at exit.
 *
 * A function-local static is initialised on first use, thread-safely, and
 * destroyed at exit -- exactly the lifetime Winsock wants, without a global
 * that main() has to remember to touch. Returns false if the library refused
 * to start, so the caller can say that rather than reporting the
 * WSANOTINITIALISED that every later call would produce.
 */
inline bool SockStartup()
{
#ifdef _WIN32
    struct Winsock {
        int rc;
        Winsock()  { WSADATA d; rc = ::WSAStartup(MAKEWORD(2, 2), &d); }
        ~Winsock() { if (rc == 0) ::WSACleanup(); }
    };
    static Winsock once;
    return once.rc == 0;
#else
    return true;
#endif
}

inline void CloseSock(sock_t s)
{
#ifdef _WIN32
    ::closesocket(s);
#else
    ::close(s);
#endif
}

/** The error code of the socket call that just failed. */
inline int SockErr()
{
#ifdef _WIN32
    return ::WSAGetLastError();
#else
    return errno;
#endif
}

/**
 * That code as a sentence.
 *
 * Windows keeps socket errors out of strerror()'s table, so a port that
 * forgets this prints "read failed: Unknown error" and leaves the reader with
 * nothing to search for. FormatMessage gives the same text the operating
 * system gives its own tools -- "An existing connection was forcibly closed
 * by the remote host" -- which is what somebody diagnosing a pool needs.
 */
inline std::string SockErrStr(int e)
{
#ifdef _WIN32
    char* buf = nullptr;
    const DWORD n = ::FormatMessageA(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
        FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, static_cast<DWORD>(e),
        MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        reinterpret_cast<LPSTR>(&buf), 0, nullptr);

    std::string msg;
    if (n != 0 && buf != nullptr) msg.assign(buf, n);
    if (buf != nullptr) ::LocalFree(buf);

    while (!msg.empty() && (msg.back() == '\n' || msg.back() == '\r' ||
                            msg.back() == ' '  || msg.back() == '.')) {
        msg.pop_back();
    }
    if (msg.empty()) msg = "winsock error " + std::to_string(e);
    return msg;
#else
    return std::strerror(e);
#endif
}

/**
 * "The socket was asked and had nothing to give."
 *
 * WSAETIMEDOUT belongs in this set, and its absence is the mistake described
 * at the top of this file: with a one-second SO_RCVTIMEO it is the ordinary
 * outcome of a quiet second, not a failure.
 */
inline bool SockWouldBlock(int e)
{
#ifdef _WIN32
    return e == WSAEWOULDBLOCK || e == WSAETIMEDOUT || e == WSAEINTR;
#else
    return e == EAGAIN || e == EWOULDBLOCK || e == EINTR;
#endif
}

/** Interrupted before anything was transferred; the call may be retried. */
inline bool SockInterrupted(int e)
{
#ifdef _WIN32
    return e == WSAEINTR;
#else
    return e == EINTR;
#endif
}

/**
 * A send or receive timeout, in whole seconds.
 *
 * optname is SO_RCVTIMEO or SO_SNDTIMEO. The units differ by platform and the
 * argument type differs with them; that is the whole reason this is a function
 * and not two lines at the call site.
 */
inline void SetSockTimeout(sock_t s, int optname, int seconds)
{
#ifdef _WIN32
    DWORD ms = static_cast<DWORD>(seconds) * 1000u;
    ::setsockopt(s, SOL_SOCKET, optname,
                 reinterpret_cast<const char*>(&ms), sizeof(ms));
#else
    timeval to{};
    to.tv_sec = seconds;
    ::setsockopt(s, SOL_SOCKET, optname,
                 reinterpret_cast<const void*>(&to), sizeof(to));
#endif
}

/** An on/off or integer socket option -- TCP_NODELAY, SO_KEEPALIVE. */
inline void SetSockFlag(sock_t s, int level, int optname, int value)
{
#ifdef _WIN32
    ::setsockopt(s, level, optname,
                 reinterpret_cast<const char*>(&value), sizeof(value));
#else
    ::setsockopt(s, level, optname,
                 reinterpret_cast<const void*>(&value), sizeof(value));
#endif
}

/** connect(), whose length argument is int here and socklen_t there. */
inline int ConnectTo(sock_t s, const sockaddr* addr, size_t len)
{
#ifdef _WIN32
    return ::connect(s, addr, static_cast<int>(len));
#else
    return ::connect(s, addr, static_cast<socklen_t>(len));
#endif
}

// recv() and send() take an int length on Windows and a size_t here, and
// return int there and ssize_t here. The buffers in stratum.h are 8 KiB and
// the lines are a few hundred bytes, so long is wide enough on both.
inline long RecvSome(sock_t s, char* buf, size_t len)
{
#ifdef _WIN32
    return ::recv(s, buf, static_cast<int>(len), 0);
#else
    return ::recv(s, buf, len, 0);
#endif
}

inline long SendSome(sock_t s, const char* buf, size_t len)
{
#ifdef _WIN32
    return ::send(s, buf, static_cast<int>(len), kSendFlags);
#else
    return ::send(s, buf, len, kSendFlags);
#endif
}

// ---------------------------------------------------------------------------
//  Local time
// ---------------------------------------------------------------------------

/**
 * localtime, into a caller-owned struct tm.
 *
 * The reentrant form is localtime_r on POSIX and localtime_s on Windows, and
 * localtime_s TAKES ITS ARGUMENTS IN THE OPPOSITE ORDER -- destination first.
 * A #define mapping one name to the other compiles and then writes a struct tm
 * through a time_t pointer, which is a stack corruption that happens to be
 * silent most of the time. So the call is written out for each platform
 * instead.
 */
inline void LocalTime(std::time_t t, std::tm& out)
{
#ifdef _WIN32
    ::localtime_s(&out, &t);
#else
    ::localtime_r(&t, &out);
#endif
}

// ---------------------------------------------------------------------------
//  The terminal
// ---------------------------------------------------------------------------

/**
 * Make ANSI escapes mean what they say, and report whether they do.
 *
 * The miner colours its output, which works everywhere on Unix and on Windows
 * only if the console has virtual-terminal processing switched on. Windows
 * Terminal enables it; the cmd.exe window somebody gets by double-clicking
 * does not, and there the first line of output is
 *
 *     <-[90m02:31:44<-[0m <-[36mminer<-[0m  starting
 *
 * which reads as a broken program to the exact person we are trying not to
 * lose. Returns false when colour cannot be made to work, so the caller can
 * fall back to plain text rather than printing rubbish.
 */
inline bool EnableAnsiColour()
{
#ifdef _WIN32
    const HANDLE h = ::GetStdHandle(STD_OUTPUT_HANDLE);
    if (h == INVALID_HANDLE_VALUE || h == nullptr) return false;

    DWORD mode = 0;
    if (!::GetConsoleMode(h, &mode)) {
        // Not a console at all -- redirected to a file or a pipe. Escapes
        // would be stored as bytes in the log, so say no.
        return false;
    }
#  ifndef ENABLE_VIRTUAL_TERMINAL_PROCESSING
#    define ENABLE_VIRTUAL_TERMINAL_PROCESSING 0x0004
#  endif
    if (mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING) return true;
    return ::SetConsoleMode(h, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0;
#else
    return true;
#endif
}

}  // namespace wam
