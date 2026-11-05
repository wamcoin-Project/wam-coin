#!/usr/bin/env sh

# Exit immediately if a command exits with a non-zero status
set -e

# setup dependencies with correct official repository links
sudo apt update
sudo apt install -y openjdk-17-jdk wget unzip \
    build-essential libtool autotools-dev automake pkg-config bsdmainutils \
    cmake curl git python3 \
    libevent-dev libboost-dev libsqlite3-dev


# setup Android paths
mkdir -p "$HOME/Android/Sdk"
export ANDROID_HOME="$HOME/Android/Sdk"

# Build Android Sdk Directory Structure
export ANDROID_HOME="$HOME/Android/Sdk"
mkdir -p "$ANDROID_HOME/cmdline-tools"

# Download and extract Android Command Line Tools safely
if [ ! -d "$ANDROID_HOME/cmdline-tools/latest" ]; then
    echo "Downloading Android Command Line Tools..."
    wget -q --show-progress https://dl.google.com/android/repository/commandlinetools-linux-6200805_latest.zip
    
    # Unzip to a temporary area so we can structure it properly
    unzip -q commandlinetools-linux-6200805_latest.zip -d "$ANDROID_HOME/cmdline-tools"
    mv "$ANDROID_HOME/cmdline-tools/tools" "$ANDROID_HOME/cmdline-tools/latest"
    rm commandlinetools-linux-6200805_latest.zip
fi

# Add sdkmanager directly to the active path so the script can see it right now
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# Run Android Package Configs
echo "Installing Android components..."
yes | sdkmanager --sdk_root=${ANDROID_HOME} --licenses
sdkmanager --sdk_root=${ANDROID_HOME} "build-tools;28.0.3" "platform-tools" "platforms;android-28" "cmake;3.22.1"
sdkmanager --sdk_root=${ANDROID_HOME} --install "ndk;23.1.7779620"
