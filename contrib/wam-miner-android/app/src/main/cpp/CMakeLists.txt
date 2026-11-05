cmake_minimum_required(VERSION 3.22.1)
project("wam-miner" CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Inject modern compiler flags safely to optimize performance
add_compile_options(-O3 -flto -pthread -fexceptions -frtti)
add_link_options(-Wl,--as-needed -latomic)

find_library(log-lib log)

# =======================================================================
# 1. DEFINE MAIN APPLICATION SHARED TARGET MODULE
# =======================================================================
add_library(wam-miner SHARED
        miner_jni.cpp
        src/main.cpp
)

# =======================================================================
# 2. CONFIGURE STATIC PRECOMPILED LIBRARY IMPORTS
# =======================================================================
add_library(randomx_static STATIC IMPORTED)

# Dynamically link the library based on the ABI target (handles arm64-v8a)
set_target_properties(randomx_static PROPERTIES IMPORTED_LOCATION
        ${CMAKE_CURRENT_SOURCE_DIR}/randomx/lib/${ANDROID_ABI}/librandomx.a
)

# =======================================================================
# 3. CONFIGURE ENFORCED ABSOLUTE INCLUDE PATH MATRICES
# =======================================================================
target_include_directories(wam-miner PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/src
        ${CMAKE_CURRENT_SOURCE_DIR}/randomx
)

# =======================================================================
# 4. LINK ALL SYSTEM AND CRYPTO DEPENDENCIES
# =======================================================================
target_link_libraries(wam-miner
        ${log-lib}
        randomx_static
        atomic
        m
        log)
