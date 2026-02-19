class Crew < Formula
  desc "Agent team launcher with workspace & project management"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.12.0.tar.gz"
  sha256 "7ff24fd7c62bfc8449a6a6ce107b91b614e00ae7ebd03fb44b6810e220dc13e1"
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
