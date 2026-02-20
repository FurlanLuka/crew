class Crew < Formula
  desc "Agent team launcher with workspace & project management"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.14.0.tar.gz"
  sha256 "a99ce1d9336f7be9bdc1ef2c55a70bceb16704b7c9b213d3d02c732e12491518"
  license "MIT"

  depends_on "tmux"

  def install
    bin.install "crew/crew"
  end

  def caveats
    <<~EOS
      crew requires python3 on your PATH.
      If you don't have it: brew install python@3
    EOS
  end

  test do
    assert_match "Agent team launcher", shell_output("#{bin}/crew help")
  end
end
